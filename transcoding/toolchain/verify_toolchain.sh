#!/usr/bin/env bash
#
# Prove the toolchain can do the things the engine actually asks of it.
#
#   ./verify_toolchain.sh [ffmpeg-path] [ffprobe-path]
#   ./verify_toolchain.sh                       # ffmpeg / ffprobe from PATH
#   ./verify_toolchain.sh /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
#
# Exits non-zero and names the missing capability. Run as an IMAGE BUILD STEP
# (transcoding/Dockerfile.agent, after any apt purge) so a toolchain that lost a
# codec or a filter option fails the build rather than the first customer job.
#
# What this deliberately does NOT do: assert anything about real hardware. A
# build machine has no GPU, and a build-time "nvenc works" claim would be a lie
# that hides a missing driver or a container started without the `video`
# capability. Hardware usability is a RUNTIME probe — `clipmux-transcoder doctor`
# — and this script stops at "the binary contains the feature".
#
# Why the `scale_cuda` `format` check is here at all: the distribution FFmpeg
# this project used to install ships scale_cuda *without* the `format` option, and
# the NVENC scaling path passes `scale_cuda=W:H:format=yuv420p`. The failure was
# an unreadable "Option 'format' not found" at encode time, on a GPU machine, in
# production. It is now a build-time assertion.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

FFMPEG_BIN="${1:-ffmpeg}"
FFPROBE_BIN="${2:-}"

# The filter/encoder inventories are what make the messages specific, so collect
# them once. `-hide_banner` keeps the output stable across FFmpeg versions.
failures=0
note() { printf 'verify_toolchain: %s\n' "$*"; }
ok()   { printf 'verify_toolchain: ok — %s\n' "$*"; }
fail() { printf 'verify_toolchain: FAIL — %s\n' "$*" >&2; failures=$((failures + 1)); }

command -v "$FFMPEG_BIN" >/dev/null 2>&1 || [ -x "$FFMPEG_BIN" ] \
  || { printf 'verify_toolchain: FAIL — ffmpeg not found at %s\n' "$FFMPEG_BIN" >&2; exit 1; }

# Installs under a non-system prefix keep their shared libraries beside the
# binary; add that directory so the script works against /opt/ffmpeg/bin/ffmpeg
# without the caller having to export LD_LIBRARY_PATH. A system prefix already
# has an ldconfig entry and needs nothing (prepending /usr/lib there would be
# harmless but slower, and would hide a genuinely missing library).
ffmpeg_dir="$(cd -- "$(dirname -- "$(command -v "$FFMPEG_BIN" || printf '%s' "$FFMPEG_BIN")")" && pwd)"
if [ -d "$ffmpeg_dir/../lib" ]; then
  case "$ffmpeg_dir" in
    /usr/bin|/bin|/usr/local/bin) : ;;
    *) export LD_LIBRARY_PATH="$ffmpeg_dir/../lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  esac
fi

if [ -z "$FFPROBE_BIN" ]; then
  # Prefer ffprobe from the same install prefix as the ffmpeg we were handed.
  if [ -x "$ffmpeg_dir/ffprobe" ]; then
    FFPROBE_BIN="$ffmpeg_dir/ffprobe"
  else
    FFPROBE_BIN="ffprobe"
  fi
fi
command -v "$FFPROBE_BIN" >/dev/null 2>&1 || [ -x "$FFPROBE_BIN" ] \
  || { printf 'verify_toolchain: FAIL — ffprobe not found at %s\n' "$FFPROBE_BIN" >&2; exit 1; }

# ── 0. version ───────────────────────────────────────────────────────────────
# A distribution FFmpeg is exactly the thing this recipe replaced, so an older
# build is a failure even when it happens to have every capability below.
EXPECTED_FFMPEG_VERSION=""
if [ -f "$SCRIPT_DIR/versions.env" ]; then
  # shellcheck source=versions.env disable=SC1091
  . "$SCRIPT_DIR/versions.env"
  EXPECTED_FFMPEG_VERSION="${FFMPEG_VERSION:-}"
fi

version_line="$("$FFMPEG_BIN" -hide_banner -version 2>&1 | head -n 1)"
actual_version="$(printf '%s\n' "$version_line" | sed -n 's/^ffmpeg version \([0-9][0-9.]*\).*/\1/p')"
if [ -z "$actual_version" ]; then
  fail "could not parse a version out of: $version_line"
elif [ -n "$EXPECTED_FFMPEG_VERSION" ] && [ "$actual_version" != "$EXPECTED_FFMPEG_VERSION" ]; then
  fail "ffmpeg is $actual_version but the recipe pins $EXPECTED_FFMPEG_VERSION ($FFMPEG_BIN) — this is not the managed build"
else
  ok "ffmpeg $actual_version"
fi

# Build flags are the cheapest proof that --enable-cuda-llvm and --enable-gpl
# took effect, and they are printed by every FFmpeg.
version_full="$("$FFMPEG_BIN" -hide_banner -version 2>&1)"
if printf '%s\n' "$version_full" | grep -q -- '--enable-cuda-llvm'; then
  ok "built with --enable-cuda-llvm"
else
  fail "ffmpeg was not built with --enable-cuda-llvm (scale_cuda would lack its CUDA device-code path)"
fi
if printf '%s\n' "$version_full" | grep -q -- '--enable-libdav1d'; then
  ok "built with --enable-libdav1d"
else
  fail "ffmpeg was not built with --enable-libdav1d (AV1 decoding falls back to a slow path)"
fi
if printf '%s\n' "$version_full" | grep -q -- '--enable-libzimg'; then
  ok "built with --enable-libzimg"
else
  fail "ffmpeg was not built with --enable-libzimg (the zscale HDR→SDR chain is unavailable)"
fi

# ── The inventory probes ─────────────────────────────────────────────────────
ENCODERS="$("$FFMPEG_BIN" -hide_banner -encoders 2>&1)"
DECODERS="$("$FFMPEG_BIN" -hide_banner -decoders 2>&1)"
HWACCELS="$("$FFMPEG_BIN" -hide_banner -hwaccels 2>&1)"
FILTERS="$("$FFMPEG_BIN" -hide_banner -filters 2>&1)"

# `name` must appear as a whole word in the listing; the leading space keeps
# `h264_vaapi_hwaccel` in `-hwaccels` from matching a bare `h264_vaapi`.
require() {
  local kind="$1" listing="$2" name="$3" why="$4"
  if printf '%s\n' "$listing" | grep -qE "(^|[[:space:]])${name}([[:space:]]|$)"; then
    ok "$kind $name"
  else
    fail "missing $kind: $name — $why"
  fi
}

note "checking encoders"
require encoder "$ENCODERS" libx264     "the CPU ladder is built on libx264; nothing else is a fallback for it"
require encoder "$ENCODERS" h264_nvenc  "NVIDIA H.264 encode path"
require encoder "$ENCODERS" hevc_nvenc  "NVIDIA H.265 encode path"
require encoder "$ENCODERS" h264_vaapi  "AMD/Intel VAAPI encode path"

note "checking decoders"
require decoder "$DECODERS" h264        "software H.264 decode (every job without a GPU decoder)"
require decoder "$DECODERS" hevc        "software H.265 decode"
require decoder "$DECODERS" libdav1d    "AV1 decode — the engine's AV1 source path (FFmpeg's native 'av1' decoder is not a substitute)"
require decoder "$DECODERS" vp9         "VP9 decode"
require decoder "$DECODERS" aac         "AAC decode"
require decoder "$DECODERS" opus        "Opus decode (WebM/Opus sources)"

note "checking hardware accelerators"
require hwaccel "$HWACCELS" cuda        "--hwaccel cuda for NVDEC"
require hwaccel "$HWACCELS" vaapi       "--hwaccel vaapi for AMD/Intel"

note "checking filters"
require filter "$FILTERS" scale_cuda    "GPU scaling for the NVENC path"
require filter "$FILTERS" scale_vaapi   "GPU scaling for the VAAPI path"
require filter "$FILTERS" zscale        "HDR→SDR tonemapping chain (zscale=t=linear…)"
require filter "$FILTERS" hwupload      "uploads system frames to a VAAPI device"
require filter "$FILTERS" hwupload_cuda "uploads system frames to a CUDA device"
require filter "$FILTERS" tonemap       "HDR→SDR tonemapping"
require filter "$FILTERS" loudnorm      "audio normalization (-af loudnorm=I=-16:TP=-1.5:LRA=11)"

# ── scale_cuda's `format` option ─────────────────────────────────────────────
# The regression this whole recipe exists for. `format` is an AVOption of
# scale_cuda, so `-h filter=scale_cuda` lists it as `   format <string> ...`.
# Anchoring on the option-name column avoids matching the word "format" inside a
# help string (scale and scale_vaapi both mention it without having the option).
scale_cuda_help="$("$FFMPEG_BIN" -hide_banner -h filter=scale_cuda 2>&1 || true)"
if printf '%s\n' "$scale_cuda_help" | grep -qE '^[[:space:]]*format[[:space:]]+<'; then
  ok "scale_cuda has the 'format' option (scale_cuda=W:H:format=yuv420p)"
else
  fail "scale_cuda is present but has no 'format' option — the NVENC scaling path passes scale_cuda=W:H:format=yuv420p and would fail at encode time. This is the exact defect the source build replaced."
fi

# ── A real encode ────────────────────────────────────────────────────────────
# Everything above reads FFmpeg's self-description. This is the only check that
# runs the pipeline: decode a synthetic source, filter it, encode with libx264,
# mux it, and read the result back with ffprobe.
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/clipmux-toolchain-check.XXXXXX")"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

note "encoding 2 frames of testsrc with libx264"
if "$FFMPEG_BIN" -hide_banner -nostdin -loglevel error -y \
     -f lavfi -i "testsrc=size=320x240:rate=25" \
     -frames:v 2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
     -f mp4 "$tmpdir/encode.mp4"; then
  if [ -s "$tmpdir/encode.mp4" ]; then
    probe="$("$FFPROBE_BIN" -hide_banner -loglevel error -select_streams v:0 \
              -show_entries stream=codec_name,width,height,nb_read_frames \
              -count_frames -of default=noprint_wrappers=1 "$tmpdir/encode.mp4" 2>&1 || true)"
    if printf '%s\n' "$probe" | grep -q 'codec_name=h264'; then
      ok "real CPU encode round-trips ($(printf '%s' "$probe" | tr '\n' ' ' | sed 's/  */ /g'))"
    else
      fail "the libx264 output is not readable as H.264 by ffprobe: $probe"
    fi
  else
    fail "ffmpeg exited 0 but produced an empty file — the encode did not happen"
  fi
else
  fail "ffmpeg could not encode 2 frames of testsrc with libx264 (see the ffmpeg output above)"
fi
rm -rf "$tmpdir"
trap - EXIT

# ── Verdict ──────────────────────────────────────────────────────────────────
if [ "$failures" -ne 0 ]; then
  printf 'verify_toolchain: %d capability check(s) failed\n' "$failures" >&2
  exit 1
fi
note "all capability checks passed (hardware usability is a runtime probe, not asserted here)"
