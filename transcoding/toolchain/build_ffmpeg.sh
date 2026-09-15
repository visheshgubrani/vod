#!/usr/bin/env bash
#
# Build the ONE shared FFmpeg every managed image uses.
#
#   ./build_ffmpeg.sh [install-prefix]        # default /usr/local
#   CLIPMUX_BUILD_DIR=/var/tmp/ffmpeg-build ./build_ffmpeg.sh /usr/local
#   JOBS=8 ./build_ffmpeg.sh /usr/local
#   ./build_ffmpeg.sh --force /usr/local      # rebuild even if the manifest matches
#
# Consumed by:
#   transcoding/Dockerfile.agent      (self-hosted agent image, Ubuntu 24.04)
#   transcoding/main.py               (Modal runner image, CUDA 12.9/cuDNN 9)
#
# Both images get the same bytes and the same configure line, which is the whole
# point: a rendition produced on a workstation and one produced on Modal must not
# differ because one of them came from a distribution package.
#
# Why we build rather than `apt-get install ffmpeg`:
#
#   * `scale_cuda` in a distribution build has no `format` option, and the NVENC
#     scaling path passes `scale_cuda=W:H:format=yuv420p`. FFmpeg's configure
#     gates the CUDA filters on `cuda_nvcc` *or* `cuda_llvm`, so
#     `--enable-cuda-llvm` is what makes `scale_cuda` exist with its options —
#     and it compiles the device code with clang to PTX
#     (`-S -nocudalib -nocudainc --cuda-device-only \
#       -include compat/cuda/cuda_runtime.h`), which means NO CUDA toolkit and no
#     nvcc are needed to build. Only clang plus the ffnvcodec headers.
#   * The driver is reached by dlopen at RUNTIME. Nothing here proves a GPU
#     works, and nothing here may pretend to: hardware usability is a runtime
#     probe (`clipmux-transcoder doctor`).
#
# The default `--nvccflags` is `--cuda-gpu-arch=sm_30 -O2`, which modern clang
# rejects outright (sm_30 was dropped long ago). We pass an explicit
# `--nvccflags=--cuda-gpu-arch=sm_75 -O2` instead. sm_75 (Turing) is the intended
# baseline: the driver JITs that PTX forward onto every newer GPU, so one built
# binary runs on the whole fleet, and the filters do not need a per-arch fatbin.
#
# Idempotent: a manifest at <prefix>/share/clipmux/toolchain.json records the
# version, the configure line, the source hashes and a hash of this script. If it
# matches what would be built now, the script stops before downloading anything.
#
# Installs, next to the binaries:
#   <prefix>/share/clipmux/toolchain.json          build manifest (machine-readable)
#   <prefix>/share/doc/clipmux-ffmpeg/LICENSE.md        FFmpeg's own license text
#   <prefix>/share/doc/clipmux-ffmpeg/COPYING.GPLv2     ... and the two it offers
#   <prefix>/share/doc/clipmux-ffmpeg/COPYING.LGPLv2.1  ... under --enable-gpl
#   <prefix>/share/doc/clipmux-ffmpeg/NOTICE            exact source URLs/versions
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

die() { printf 'build_ffmpeg: ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf 'build_ffmpeg: %s\n' "$*"; }

FORCE=0
PREFIX="/usr/local"
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,50p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) PREFIX="$arg" ;;
  esac
done

PREFIX="$(readlink -f -- "$PREFIX" 2>/dev/null || printf '%s' "$PREFIX")"

# ── Inputs ───────────────────────────────────────────────────────────────────
# versions.env is the single source of truth; this script hard-codes nothing.
[ -f "$SCRIPT_DIR/versions.env" ] || die "missing $SCRIPT_DIR/versions.env"
# shellcheck source=versions.env disable=SC1091
. "$SCRIPT_DIR/versions.env"
# apt-packages.env names the runtime libraries the verification step cross-checks.
APT_PACKAGES_ENV="$SCRIPT_DIR/apt-packages.env"

: "${FFMPEG_VERSION:?versions.env must set FFMPEG_VERSION}"
: "${FFMPEG_SHA256:?versions.env must set FFMPEG_SHA256}"
: "${FFMPEG_URL:?versions.env must set FFMPEG_URL}"
: "${NV_CODEC_HEADERS_VERSION:?versions.env must set NV_CODEC_HEADERS_VERSION}"
: "${NV_CODEC_HEADERS_SHA:?versions.env must set NV_CODEC_HEADERS_SHA}"
: "${NV_CODEC_HEADERS_SHA256:?versions.env must set NV_CODEC_HEADERS_SHA256}"
: "${NV_CODEC_HEADERS_URL:?versions.env must set NV_CODEC_HEADERS_URL}"
[ "${#FFMPEG_SHA256}" -eq 64 ] || die "FFMPEG_SHA256 is not a sha256 hex digest"
[ "${#NV_CODEC_HEADERS_SHA}" -eq 40 ] || die "NV_CODEC_HEADERS_SHA is not a 40-char commit sha"
[ "${#NV_CODEC_HEADERS_SHA256}" -eq 64 ] || die "NV_CODEC_HEADERS_SHA256 is not a sha256"

BUILD_DIR="${CLIPMUX_BUILD_DIR:-/tmp/clipmux-ffmpeg-build}"
JOBS="${JOBS:-$(nproc)}"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || die "JOBS must be a positive integer (got '$JOBS')"

FFMPEG_SRC="$BUILD_DIR/ffmpeg-$FFMPEG_VERSION"
NV_SRC="$BUILD_DIR/nv-codec-headers-${NV_CODEC_HEADERS_SHA}"
BUILD_JOBS_DIR="$BUILD_DIR/build"
DOWNLOADS="$BUILD_DIR/downloads"
MANIFEST="$PREFIX/share/clipmux/toolchain.json"
DOC_DIR="$PREFIX/share/doc/clipmux-ffmpeg"

# ── The configure line (the contract with verify_toolchain.sh) ───────────────
# Every capability the engine relies on is named here, and the build manifest
# records the exact line so a deployed binary can be traced back to it.
CONFIGURE_ARGS=(
  --prefix="$PREFIX"
  --enable-gpl
  # CUDA filters with clang instead of nvcc, and the reason `scale_cuda` has a
  # `format` option at all. `--disable-cuda-nvcc` pins the llvm leg explicitly:
  # FFmpeg defaults to enabling cuda_nvcc when the toolkit is present, and that
  # leg would then try to link libcuda/libnpp into a shared build.
  --enable-cuda-llvm
  --disable-cuda-nvcc
  --enable-nvenc
  --enable-nvdec
  --enable-cuvid
  --enable-vaapi
  --enable-libx264
  # AV1 decode via libdav1d: the engine's AV1 source path, and the only AV1
  # decoder fast enough for a 4K ladder (FFmpeg's native one is a fallback).
  --enable-libdav1d
  --enable-libopus
  # zimg is what makes `zscale` exist, and `zscale`+`tonemap` is the HDR→SDR
  # chain the encoder builds. Without libzimg, HDR sources fail at the filter.
  --enable-libzimg
  --enable-pthreads
  --enable-shared
  --disable-static
  --disable-doc
  --disable-debug
  # Baseline PTX that every newer driver JITs forward; see the header comment.
  --nvcc=clang
  "--nvccflags=--cuda-gpu-arch=sm_75 -O2"
  # Extra codecs the container/normalization paths can reach for. Kept small on
  # purpose: each one is a library the agent image must also carry at runtime.
  --enable-libx265
  --enable-libvpx
  --enable-libaom
  --enable-libmp3lame
  --enable-libvorbis
  --enable-libwebp
  --enable-libass
  --enable-libfreetype
  --enable-libfribidi
  --enable-libharfbuzz
 
)

# sha256 of this script: the manifest is only "current" for the exact recipe that
# wrote it, so editing the configure line invalidates an old install.
SCRIPT_SHA256="$(sha256sum "$SCRIPT_DIR/versions.env" "${BASH_SOURCE[0]}" | sha256sum | cut -d' ' -f1)"

# ── Idempotency ──────────────────────────────────────────────────────────────
manifest_field() {
  [ -f "$MANIFEST" ] || return 1
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' \
    "$MANIFEST" "$1" 2>/dev/null
}

if [ "$FORCE" -eq 0 ] && [ -f "$MANIFEST" ] && [ -x "$PREFIX/bin/ffmpeg" ]; then
  if [ "$(manifest_field ffmpeg_version)" = "$FFMPEG_VERSION" ] \
     && [ "$(manifest_field recipe_sha256)" = "$SCRIPT_SHA256" ]; then
    log "already built: $PREFIX/bin/ffmpeg reports FFmpeg $FFMPEG_VERSION"
    log "manifest: $MANIFEST (use --force to rebuild)"
    exit 0
  fi
  log "existing install does not match this recipe — rebuilding"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v make >/dev/null 2>&1 || die "make is required"
command -v pkg-config >/dev/null 2>&1 || die "pkg-config is required (lib*-dev packages provide the .pc files)"

# ── Downloads, verified, cached ──────────────────────────────────────────────
mkdir -p "$DOWNLOADS" "$BUILD_JOBS_DIR"

# fetch_and_verify <url> <sha256> <destination>
fetch_and_verify() {
  local url="$1" want="$2" dest="$3"
  if [ -f "$dest" ] && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$want" ]; then
    log "cached + verified $(basename "$dest")"
    return 0
  fi
  log "downloading $url"
  rm -f "$dest"
  curl -fsSL --retry 3 --retry-delay 5 -o "$dest" "$url" \
    || die "download failed: $url"
  local got
  got="$(sha256sum "$dest" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || die "sha256 mismatch for $url
  expected $want
  got      $got"
  log "verified sha256 $(basename "$dest")"
}

FFMPEG_TARBALL="$DOWNLOADS/ffmpeg-${FFMPEG_VERSION}.tar.xz"
NV_TARBALL="$DOWNLOADS/nv-codec-headers-${NV_CODEC_HEADERS_SHA}.tar.gz"

fetch_and_verify "$FFMPEG_URL" "$FFMPEG_SHA256" "$FFMPEG_TARBALL"
fetch_and_verify "$NV_CODEC_HEADERS_URL" "$NV_CODEC_HEADERS_SHA256" "$NV_TARBALL"

# ── nv-codec-headers ─────────────────────────────────────────────────────────
# Installed to /usr (NOT the FFmpeg prefix): `make install PREFIX=/usr` puts
# ffnvcodec.pc in /usr/share/pkgconfig, where pkg-config already looks, so
# FFmpeg's configure finds `ffnvcodec >= 12.1.14.0` however this script is
# invoked. It is headers-only — nothing lands in the runtime image.
nv_headers_installed() {
  command -v pkg-config >/dev/null 2>&1 || return 1
  pkg-config --atleast-version="${NV_CODEC_HEADERS_VERSION#n}" ffnvcodec 2>/dev/null \
    && [ -f /usr/include/ffnvcodec/nvEncodeAPI.h ]
}

if [ "$FORCE" -eq 0 ] && nv_headers_installed; then
  log "nv-codec-headers $(pkg-config --modversion ffnvcodec) already installed"
else
  rm -rf "$NV_SRC"
  mkdir -p "$NV_SRC"
  log "unpacking nv-codec-headers $NV_CODEC_HEADERS_VERSION"
  tar -xf "$NV_TARBALL" -C "$NV_SRC" --strip-components=1
  make -C "$NV_SRC" -j"$JOBS" install PREFIX=/usr
  log "installed ffnvcodec $(pkg-config --modversion ffnvcodec 2>/dev/null || echo '?') to /usr"
fi

# Fail before a 10-minute FFmpeg compile, not during configure.
pkg-config --exists ffnvcodec || die "ffnvcodec.pc not visible to pkg-config after installing nv-codec-headers"
ffnvcodec_version="$(pkg-config --modversion ffnvcodec)"
log "pkg-config sees ffnvcodec $ffnvcodec_version"

# ── FFmpeg ───────────────────────────────────────────────────────────────────
rm -rf "$FFMPEG_SRC"
mkdir -p "$FFMPEG_SRC"
log "unpacking FFmpeg $FFMPEG_VERSION"
tar -xf "$FFMPEG_TARBALL" -C "$FFMPEG_SRC" --strip-components=1

CONFIGURE_LINE="./configure $(printf '%s ' "${CONFIGURE_ARGS[@]}")"
printf '%s\n' "$CONFIGURE_LINE" > "$BUILD_JOBS_DIR/configure-line.txt"
log "configuring: $CONFIGURE_LINE"
(
  cd "$FFMPEG_SRC"
  ./configure "${CONFIGURE_ARGS[@]}" > "$BUILD_JOBS_DIR/configure.log" 2>&1 \
    || { tail -n 60 "$BUILD_JOBS_DIR/configure.log" >&2; die "configure failed (full log: $BUILD_JOBS_DIR/configure.log)"; }
)
# The reasons this build exists, asserted at configure time so a misassembled
# configure line cannot produce an image that "built fine" but cannot encode.
# `config_components.h` carries the component flags and `config.h` the feature
# flags; both are generated by configure from the flags above.
grep -q '^#define CONFIG_SCALE_CUDA_FILTER 1' "$FFMPEG_SRC/config_components.h" \
  || die "configure did not enable scale_cuda — is clang present for --enable-cuda-llvm?"
grep -q '^#define CONFIG_CUDA_LLVM 1' "$FFMPEG_SRC/config.h" \
  || die "configure did not enable cuda_llvm"
grep -q '^#define CONFIG_ZSCALE_FILTER 1' "$FFMPEG_SRC/config_components.h" \
  || die "configure did not enable zscale — is libzimg-dev installed?"

log "compiling with -j$JOBS (this is the slow part)"
make -C "$FFMPEG_SRC" -j"$JOBS" > "$BUILD_JOBS_DIR/make.log" 2>&1 \
  || { tail -n 60 "$BUILD_JOBS_DIR/make.log" >&2; die "make failed (full log: $BUILD_JOBS_DIR/make.log)"; }

log "installing to $PREFIX"
make -C "$FFMPEG_SRC" install > "$BUILD_JOBS_DIR/install.log" 2>&1 \
  || { tail -n 60 "$BUILD_JOBS_DIR/install.log" >&2; die "make install failed (full log: $BUILD_JOBS_DIR/install.log)"; }

[ -x "$PREFIX/bin/ffmpeg" ] || die "no ffmpeg binary at $PREFIX/bin/ffmpeg after install"
[ -x "$PREFIX/bin/ffprobe" ] || die "no ffprobe binary at $PREFIX/bin/ffprobe after install"

# ── The shared-library path ──────────────────────────────────────────────────
# System prefixes get an ldconfig run so `ldd` resolves libav*.so without any
# environment variable. A custom prefix needs LD_LIBRARY_PATH (or the container's
# own ld.so.conf.d entry) — say so instead of leaving a mystery at first run.
case "$PREFIX" in
  /usr|/usr/local|/usr/*)
    if command -v ldconfig >/dev/null 2>&1; then
      if [ "$(id -u)" -eq 0 ]; then
        ldconfig
        log "ldconfig refreshed for $PREFIX/lib"
      else
        log "WARNING: not uid 0 — run 'ldconfig' as root so $PREFIX/lib is on the loader path"
      fi
    fi
    ;;
  *)
    log "NOTE: custom prefix — set LD_LIBRARY_PATH=$PREFIX/lib (and PATH=$PREFIX/bin) at runtime"
    ;;
esac

# ── Licensing ────────────────────────────────────────────────────────────────
mkdir -p "$DOC_DIR"
for f in LICENSE.md COPYING.GPLv2 COPYING.LGPLv2.1; do
  [ -f "$FFMPEG_SRC/$f" ] || die "FFmpeg source is missing $f — license files must ship with the binaries"
  install -m 0644 "$FFMPEG_SRC/$f" "$DOC_DIR/$f"
done

cat > "$DOC_DIR/NOTICE" <<NOTICE
ClipMux media toolchain
=======================

This directory accompanies a locally built FFmpeg. The binaries in
${PREFIX}/bin are NOT a distribution package; they are built from source by
transcoding/toolchain/build_ffmpeg.sh so that the CUDA filters (scale_cuda) are
present with their full option set.

FFmpeg ${FFMPEG_VERSION}
  source:  ${FFMPEG_URL}
  sha256:  ${FFMPEG_SHA256}
  license: GPLv2+ (built with --enable-gpl; see LICENSE.md, COPYING.GPLv2)
  configure: see ${PREFIX}/share/clipmux/toolchain.json

nv-codec-headers ${NV_CODEC_HEADERS_VERSION}
  source:  ${NV_CODEC_HEADERS_URL}
  commit:  ${NV_CODEC_HEADERS_SHA}
  sha256:  ${NV_CODEC_HEADERS_SHA256}
  license: MIT (headers only; installed under /usr/include/ffnvcodec)
  Driver floor: the NVENC/NVDEC API in this release requires an NVIDIA Linux
  driver >= 530.41.03. That is a RUNTIME requirement — this build does not
  probe for a GPU, it only compiles the API against these headers.

FFmpeg is linked against the distribution's shared libraries (libx264, libx265,
libvpx, libaom, libdav1d, libopus, libmp3lame, libvorbis, libwebp, libzimg,
libass, libfreetype, libfribidi, libharfbuzz, libva). Their licenses are those
of their own packages; this build does not statically link them.

Note on VDPAU: the external *libvdpau* library option no longer exists upstream
(it was removed when VDPAU became a built-in hwaccel), so passing it is a
configure error — "Unknown option" — after a full apt install and source
download. This project targets NVENC and VAAPI, so neither the flag nor the
headers nor the runtime library are part of the recipe.

Shaka Packager ${SHAKA_VERSION}
  source:  ${SHAKA_URL}
  sha256:  ${SHAKA_SHA256}
  license: Apache-2.0 (fetched separately by the image build, not by this script)

No claim of warranty is made. See the LICENSE files distributed with each
component.
NOTICE
log "wrote $DOC_DIR/NOTICE"

# ── Manifest ─────────────────────────────────────────────────────────────────
# `unresolved` is the authority on whether the install is usable: ldd names the
# libraries the binary actually links, so it cannot drift from the configure
# line the way a hand-kept list can.
unresolved="$(ldd "$PREFIX/bin/ffmpeg" 2>/dev/null | grep 'not found' || true)"
[ -z "$unresolved" ] || die "ffmpeg has unresolved shared libraries:
$unresolved"

MISSING_RUNTIME_PACKAGES=""
if [ -f "$APT_PACKAGES_ENV" ]; then
  # shellcheck source=apt-packages.env disable=SC1091
  . "$APT_PACKAGES_ENV"
  if command -v dpkg-query >/dev/null 2>&1; then
    for pkg in "${CLIPMUX_RUNTIME_PACKAGES[@]}"; do
      dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' \
        || MISSING_RUNTIME_PACKAGES="$MISSING_RUNTIME_PACKAGES $pkg"
    done
    if [ -n "$MISSING_RUNTIME_PACKAGES" ]; then
      # A warning, not a failure: `ldd` above is the authority, and on a
      # non-Debian host these names mean nothing. The image build installs them
      # and verify_toolchain.sh is what has to pass.
      log "WARNING: runtime packages not installed here:$MISSING_RUNTIME_PACKAGES"
      log "         install them before purging build deps, or ffmpeg will not load"
    fi
  fi
fi

BUILD_MANIFEST="$MANIFEST" \
PREFIX="$PREFIX" \
FFMPEG_VERSION="$FFMPEG_VERSION" \
FFMPEG_URL="$FFMPEG_URL" \
FFMPEG_SHA256="$FFMPEG_SHA256" \
NV_CODEC_HEADERS_VERSION="$NV_CODEC_HEADERS_VERSION" \
NV_CODEC_HEADERS_SHA="$NV_CODEC_HEADERS_SHA" \
NV_CODEC_HEADERS_SHA256="$NV_CODEC_HEADERS_SHA256" \
NV_CODEC_HEADERS_URL="$NV_CODEC_HEADERS_URL" \
SHAKA_VERSION="$SHAKA_VERSION" \
SHAKA_SHA256="$SHAKA_SHA256" \
SHAKA_URL="$SHAKA_URL" \
CONFIGURE_LINE="$CONFIGURE_LINE" \
RECIPE_SHA256="$SCRIPT_SHA256" \
FFNVCODEC_VERSION="$ffnvcodec_version" \
CC_VERSION="$(clang --version 2>/dev/null | head -n 1 || echo unknown)" \
JOBS="$JOBS" \
python3 - <<'PY'
import json, os, platform, datetime, subprocess

def shared_libs(binary):
    out = subprocess.run(["ldd", binary], capture_output=True, text=True).stdout
    libs = []
    for line in out.splitlines():
        line = line.strip()
        if "=>" not in line:
            continue
        name, rest = line.split("=>", 1)
        path = rest.strip().split(" ")[0]
        if path.startswith("/"):
            libs.append({"name": name.strip(), "path": path})
    return sorted(libs, key=lambda x: x["name"])

manifest = {
    "name": "clipmux-media-toolchain",
    "component": "ffmpeg",
    "ffmpeg_version": os.environ["FFMPEG_VERSION"],
    "ffmpeg_url": os.environ["FFMPEG_URL"],
    "ffmpeg_sha256": os.environ["FFMPEG_SHA256"],
    "nv_codec_headers_version": os.environ["NV_CODEC_HEADERS_VERSION"],
    "nv_codec_headers_sha": os.environ["NV_CODEC_HEADERS_SHA"],
    "nv_codec_headers_sha256": os.environ["NV_CODEC_HEADERS_SHA256"],
    "nv_codec_headers_url": os.environ["NV_CODEC_HEADERS_URL"],
    "ffnvcodec_pkgconfig_version": os.environ.get("FFNVCODEC_VERSION", ""),
    "shaka": {
        "version": os.environ["SHAKA_VERSION"],
        "sha256": os.environ["SHAKA_SHA256"],
        "url": os.environ["SHAKA_URL"],
    },
    "configure": os.environ["CONFIGURE_LINE"],
    "install_prefix": os.environ["PREFIX"],
    "target_arch": platform.machine(),
    "jobs": int(os.environ["JOBS"]),
    "compiler": os.environ.get("CC_VERSION", ""),
    "build_date": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "recipe_sha256": os.environ["RECIPE_SHA256"],
    "shared_libraries": shared_libs(os.path.join(os.environ["PREFIX"], "bin", "ffmpeg")),
}
path = os.environ["BUILD_MANIFEST"]
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as fh:
    json.dump(manifest, fh, indent=2, sort_keys=True)
    fh.write("\n")
print("build_ffmpeg: wrote " + path)
PY

"$PREFIX/bin/ffmpeg" -hide_banner -version | head -n 3
log "done. Verify with: $SCRIPT_DIR/verify_toolchain.sh $PREFIX/bin/ffmpeg $PREFIX/bin/ffprobe"
