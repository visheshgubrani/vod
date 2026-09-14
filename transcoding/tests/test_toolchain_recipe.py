"""The toolchain recipe must stay internally consistent.

No docker, no ffmpeg: these tests read the recipe files as text and assert on
literals. One class goes further and fetches FFmpeg's `configure` to check that
every `--enable-*` in the recipe is a real option of the pinned release — cached
by version outside the repository, and skipped rather than failed when offline.
This is the cheap guard in front of an expensive signal — the real check is
`verify_toolchain.sh` inside the image build, which actually executes FFmpeg.
What this module catches is the drift that would otherwise be discovered twenty
minutes into a CUDA image build:

  * versions.env losing a hash, so the build stops verifying what it downloads;
  * the configure line losing `--enable-cuda-llvm`, which is the ONLY reason
    `scale_cuda` exists with its `format` option (the defect this recipe
    replaced: a distribution build whose scale_cuda had no `format`);
  * the verification script quietly dropping a capability check, or the
    `format` assertion, or the real encode;
  * the shared recipe never running in the agent image — i.e. the image going
    back to a distribution FFmpeg while everything else still looks right;
  * a Whisper or Modal dependency leaking into the engine's core dependency set,
    which `test_engine_isolation.py` says must keep importing without them.
"""
from __future__ import annotations

import json
import ast
import re
import pytest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
TRANSCODING_DIR = TESTS_DIR.parent
REPO_ROOT = TRANSCODING_DIR.parent
TOOLCHAIN_DIR = TRANSCODING_DIR / "toolchain"

VERSIONS_ENV = TOOLCHAIN_DIR / "versions.env"
APT_PACKAGES_ENV = TOOLCHAIN_DIR / "apt-packages.env"
BUILD_SCRIPT = TOOLCHAIN_DIR / "build_ffmpeg.sh"
VERIFY_SCRIPT = TOOLCHAIN_DIR / "verify_toolchain.sh"
REQUIREMENTS_LOCK = TOOLCHAIN_DIR / "requirements-managed.lock"
PYPROJECT = TRANSCODING_DIR / "pyproject.toml"
DOCKERFILE = TRANSCODING_DIR / "Dockerfile.agent"
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"

# The two files the Modal CLI mounts as *loose* files at the container's /root
# (the engine travels separately, as a python package).
MODAL_MAIN = TRANSCODING_DIR / "main.py"
MODAL_IMAGE_BUILD = TRANSCODING_DIR / "image_build.py"
# ...and the path the image bakes the toolchain directory to. `main.py` passes
# this same literal to `add_local_dir(remote_path=...)`, which is the only
# reason a runtime read of it can ever succeed.
TOOLCHAIN_IN_IMAGE = "/opt/openvod/toolchain"

# The pins the whole stage is built on. Literals on purpose: if a bump is
# intended, it is intended in both the file and here.
FFMPEG_VERSION = "9.0.1"
FFMPEG_SHA256 = "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"
NV_CODEC_HEADERS_VERSION = "n12.1.14.0"
NV_CODEC_HEADERS_SHA = "1889e62e2d35ff7aa9baca2bceb14f053785e6f1"
NV_CODEC_HEADERS_SHA256 = "e30d4791fd386de8b5c9f88dec781e546ec148b8808440dd421da5f26c2700ae"
SHAKA_VERSION = "v3.2.0"
SHAKA_SHA256 = "05af2e9ef5f12d58b9d615b7d31dc0eb61c32aee632c71965340b43c1556043e"
CUDA_BASE_IMAGE_DIGEST = (
    "sha256:070f8f2672df1b05b84c0409a5fd1d54ddfd646e5b9d8dee7878131271b563fc"
)

# The configure contract: every flag here is load-bearing for the engine's
# encoding paths (see transcoding/openvod_transcoder/encoding/backends.py).
REQUIRED_CONFIGURE_FLAGS = [
    "--enable-gpl",
    "--enable-cuda-llvm",
    "--enable-nvenc",
    "--enable-nvdec",
    "--enable-cuvid",
    "--enable-vaapi",
    "--enable-libx264",
    "--enable-libdav1d",
    "--enable-libopus",
    "--enable-libzimg",
    "--enable-pthreads",
    "--enable-shared",
    "--disable-static",
    "--disable-doc",
    "--disable-debug",
]

# Capabilities verify_toolchain.sh must actually ask the binary for. The keys are
# the FFmpeg listings; the values are the names that must appear in them.
REQUIRED_CAPABILITIES = {
    "-encoders": ["libx264", "h264_nvenc", "hevc_nvenc", "h264_vaapi"],
    "-decoders": ["h264", "hevc", "libdav1d", "vp9", "aac", "opus"],
    "-hwaccels": ["cuda", "vaapi"],
    "-filters": [
        "scale_cuda",
        "scale_vaapi",
        "zscale",
        "hwupload",
        "hwupload_cuda",
        "tonemap",
        "loudnorm",
    ],
}

LOCK_PINS = {
    # build/runtime
    "boto3": "1.43.93",
    "requests": "2.34.2",
    "fastapi": "0.141.1",
    "pillow": "12.3.0",
    "groq": "1.7.0",
    "modal": "1.5.5",
    # whisper stack
    "faster-whisper": "1.2.1",
    "ctranslate2": "4.8.2",
    "huggingface-hub": "1.31.0",
    "tokenizers": "0.23.2",
    "onnxruntime": "1.30.0",
    "av": "18.1.0",
    "numpy": "2.5.3",
}

# The engine and the agent must import with nothing but `requests` present;
# every other dependency is optional and lazily imported.
CORE_DEPENDENCY_NAMES = ("requests",)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def normalized(text: str) -> str:
    """Join shell/Dockerfile line continuations and collapse whitespace.

    The assertions are about what a file *says*, not how it is wrapped, so a
    reflow of the configure line must not fail a test.
    """
    joined = re.sub(r"\\\n\s*", " ", text)
    return re.sub(r"[ \t]+", " ", joined)


def env_assignments(text: str, key: str) -> list[str]:
    return re.findall(rf"^{re.escape(key)}=(\S+)$", text, re.MULTILINE)


def env_value(text: str, key: str) -> str:
    values = env_assignments(text, key)
    assert len(values) == 1, f"versions.env must set {key} exactly once, got {values!r}"
    return values[0]


def lock_pins(text: str) -> dict[str, str]:
    """name -> version for every `==` pin, ignoring comments and options."""
    pins: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.\-]+)(\[[^\]]+\])?==([^\s;]+)", line)
        assert match, f"requirements-managed.lock line is not an exact pin: {line!r}"
        pins[match.group(1).lower()] = match.group(3)
    return pins


# ── versions.env: the single source of truth ─────────────────────────────────
def install_commands(text: str):
    """
    The *arguments* of every `apt-get install` command.

    Scoped to the arguments rather than the whole RUN block: a block that
    installs runtime libraries may legitimately mention an ffmpeg path later on
    (the verification invocation does), and matching that would flag a correct
    Dockerfile.
    """
    for match in re.finditer(r"apt-get install\b(.*?);", text, re.DOTALL):
        yield match.group(1)


class TestVersionsEnv:
    def test_pins_the_verified_ffmpeg_release(self):
        text = read(VERSIONS_ENV)
        assert env_value(text, "FFMPEG_VERSION") == FFMPEG_VERSION
        assert env_value(text, "FFMPEG_SHA256") == FFMPEG_SHA256
        assert len(FFMPEG_SHA256) == 64
        # The URL is built from the version, so a version bump cannot leave a
        # stale tarball URL behind.
        assert env_value(text, "FFMPEG_URL") == (
            "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
        )

    def test_pins_nv_codec_headers_by_tag_and_commit(self):
        text = read(VERSIONS_ENV)
        assert env_value(text, "NV_CODEC_HEADERS_VERSION") == NV_CODEC_HEADERS_VERSION
        assert env_value(text, "NV_CODEC_HEADERS_SHA") == NV_CODEC_HEADERS_SHA
        assert len(NV_CODEC_HEADERS_SHA) == 40
        # A commit sha and an archive sha256 are different values; using the
        # former as a checksum fails the build (it did).
        assert env_value(text, "NV_CODEC_HEADERS_SHA256") == NV_CODEC_HEADERS_SHA256
        assert len(NV_CODEC_HEADERS_SHA256) == 64
        assert "github.com/FFmpeg/nv-codec-headers" in env_value(
            text, "NV_CODEC_HEADERS_URL"
        )

    def test_pins_shaka_packager_by_checksum(self):
        text = read(VERSIONS_ENV)
        assert env_value(text, "SHAKA_VERSION") == SHAKA_VERSION
        assert env_value(text, "SHAKA_SHA256") == SHAKA_SHA256
        assert len(SHAKA_SHA256) == 64
        assert env_value(text, "SHAKA_URL").startswith(
            "https://github.com/shaka-project/shaka-packager/releases/download/"
        )

    def test_pins_the_base_images_and_target_versions(self):
        text = read(VERSIONS_ENV)
        assert env_value(text, "CUDA_BASE_IMAGE_DIGEST") == CUDA_BASE_IMAGE_DIGEST
        base = env_value(text, "CUDA_BASE_IMAGE")
        assert base.startswith("nvidia/cuda:")
        assert "cudnn" in base, "the managed image needs cuDNN for the Whisper stack"
        # A digest reference is what makes the base image immutable.
        assert env_value(text, "CUDA_BASE_IMAGE_REF") == (
            "${CUDA_BASE_IMAGE}@${CUDA_BASE_IMAGE_DIGEST}"
        )
        assert env_value(text, "TARGET_UBUNTU_VERSION") == "24.04"
        assert env_value(text, "PYTHON_VERSION") == "3.12"

    def test_is_shell_sourceable_without_logic(self):
        text = read(VERSIONS_ENV)
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            assert re.fullmatch(r"[A-Z0-9_]+=\S+", stripped), (
                f"versions.env must hold plain assignments only: {line!r}"
            )


# ── the build recipe ─────────────────────────────────────────────────────────
class TestBuildScript:
    def test_enables_the_required_configure_flags(self):
        text = read(BUILD_SCRIPT)
        for flag in REQUIRED_CONFIGURE_FLAGS:
            assert flag in text, f"build_ffmpeg.sh no longer passes {flag}"

    def test_builds_cuda_filters_with_clang_to_ptx(self):
        text = normalized(read(BUILD_SCRIPT))
        assert "--nvcc=clang" in text, (
            "cuda-llvm compiles device code with clang; no CUDA toolkit is installed"
        )
        # FFmpeg's default is --cuda-gpu-arch=sm_30, which modern clang rejects.
        assert "--nvccflags=--cuda-gpu-arch=sm_75 -O2" in text
        # The llvm leg must be pinned explicitly: FFmpeg would otherwise enable
        # cuda_nvcc as well and try to link the CUDA toolkit into libavfilter.
        assert "--disable-cuda-nvcc" in text

    def test_verifies_the_artifacts_it_downloads(self):
        text = read(BUILD_SCRIPT)
        assert "sha256sum" in text
        assert "FFMPEG_SHA256" in text and "NV_CODEC_HEADERS_SHA256" in text
        assert (
            'fetch_and_verify "$NV_CODEC_HEADERS_URL" "$NV_CODEC_HEADERS_SHA256"'
            in text
        ), "the nv-codec-headers tarball must be verified by sha256, not by commit sha"
        # A hash mismatch has to be fatal, not advisory.
        assert "sha256 mismatch" in text

    def test_sources_versions_env_rather_than_hardcoding(self):
        text = read(BUILD_SCRIPT)
        assert "versions.env" in text
        assert FFMPEG_VERSION not in text, (
            "the version lives in versions.env; hard-coding it here lets the two drift"
        )
        assert FFMPEG_SHA256 not in text
        assert SHAKA_SHA256 not in text

    def test_uses_the_requested_build_controls(self):
        text = read(BUILD_SCRIPT)
        assert "set -euo pipefail" in text
        assert 'JOBS="${JOBS:-$(nproc)}"' in text
        assert 'make -C "$FFMPEG_SRC" -j"$JOBS"' in text
        assert "OPENVOD_BUILD_DIR" in text
        # nv-codec-headers must land where pkg-config looks, or FFmpeg's
        # configure cannot resolve `ffnvcodec >= 12.1.14.0`.
        assert "install PREFIX=/usr" in text

    def test_writes_the_build_manifest_and_licenses(self):
        text = read(BUILD_SCRIPT)
        assert "share/openvod/toolchain.json" in text
        for field in ("ffmpeg_version", "configure", "ffmpeg_sha256", "target_arch",
                      "build_date", "recipe_sha256"):
            assert f'"{field}"' in text, f"toolchain.json is missing {field}"
        assert "share/doc/openvod-ffmpeg" in text
        for license_file in ("COPYING.GPLv2", "COPYING.LGPLv2.1", "LICENSE.md", "NOTICE"):
            assert license_file in text, f"the install no longer ships {license_file}"
        assert "FFMPEG_URL" in text and "NV_CODEC_HEADERS_URL" in text

    def test_is_idempotent_and_runs_ldconfig_for_system_prefixes(self):
        text = read(BUILD_SCRIPT)
        assert "--force" in text and "manifest_field" in text
        assert "ldconfig" in text
        assert "toolchain/apt-packages.env" in text or "apt-packages.env" in text


# ── the verification step ────────────────────────────────────────────────────
class TestVerifyScript:
    def test_takes_optional_binary_paths(self):
        text = read(VERIFY_SCRIPT)
        assert 'FFMPEG_BIN="${1:-ffmpeg}"' in text
        assert "ffprobe" in text
        assert "set -euo pipefail" in text
        assert "exit 1" in text

    def test_checks_every_required_capability(self):
        text = read(VERIFY_SCRIPT)
        for listing, names in REQUIRED_CAPABILITIES.items():
            assert listing in text, f"verify_toolchain.sh no longer asks for {listing}"
            for name in names:
                assert name in text, f"verify_toolchain.sh no longer checks {name} in {listing}"

    def test_checks_the_scale_cuda_format_option(self):
        text = read(VERIFY_SCRIPT)
        assert "filter=scale_cuda" in text
        # The exact defect: scale_cuda without `format`, while the NVENC chain
        # passes scale_cuda=W:H:format=yuv420p. The check anchors on the option
        # column, so a help string that merely mentions "format" cannot satisfy it.
        assert "format[[:space:]]+<" in text
        assert "no 'format' option" in text
        assert "scale_cuda=W:H:format=yuv420p" in text

    def test_checks_the_ffmpeg_version(self):
        text = read(VERIFY_SCRIPT)
        assert "versions.env" in text
        assert "EXPECTED_FFMPEG_VERSION" in text
        # The version itself must not be duplicated here.
        assert FFMPEG_VERSION not in text
        assert "not the managed build" in text

    def test_runs_a_real_cpu_encode_and_cleans_up(self):
        text = read(VERIFY_SCRIPT)
        assert "testsrc" in text
        assert "-c:v libx264" in text
        assert "-frames:v 2" in text
        assert "mktemp -d" in text
        assert "trap cleanup EXIT" in text
        assert '-s "$tmpdir/encode.mp4"' in text, "the encode output must be checked non-empty"
        assert "ffprobe" in text

    def test_asserts_nothing_about_real_hardware(self):
        text = read(VERIFY_SCRIPT).lower()
        # Hardware usability is a runtime probe. A build machine has no GPU, so
        # any build-time encode attempt would be a false failure (or worse, a
        # false pass).
        assert "-c:v h264_nvenc" not in text
        assert "-c:v h264_vaapi" not in text
        assert "runtime probe" in text


# ── apt packages: what the purge must keep ───────────────────────────────────
class TestAptPackages:
    def test_has_no_cuda_toolkit_in_the_build_set(self):
        text = read(APT_PACKAGES_ENV)
        # --enable-cuda-llvm needs clang and the ffnvcodec headers, nothing else.
        assert "clang" in text
        assert "cuda-toolkit" not in text
        assert "nvidia-cuda-toolkit" not in text

    def test_runtime_libraries_cover_every_linked_external_library(self):
        text = read(APT_PACKAGES_ENV)
        for lib in ("libx264", "libdav1d", "libopus", "libzimg", "libva2"):
            assert lib in text, f"the runtime package list lost {lib}"


# ── the managed-image Python lock ────────────────────────────────────────────
class TestRequirementsLock:
    def test_pins_exact_versions_for_the_whole_managed_set(self):
        pins = lock_pins(read(REQUIREMENTS_LOCK))
        assert pins == LOCK_PINS

    def test_never_selects_prereleases(self):
        for name, version in lock_pins(read(REQUIREMENTS_LOCK)).items():
            assert re.fullmatch(r"\d+(\.\d+)+", version), (
                f"{name}=={version} is not a final release"
            )

    def test_records_the_validated_constraints(self):
        text = read(REQUIREMENTS_LOCK)
        # The co-installability evidence, not just the numbers.
        assert "faster-whisper" in text
        assert "requires_dist" in text or "requires:" in text
        assert "ctranslate2<5,>=4.0" in text
        assert "tokenizers<1,>=0.13" in text
        assert "onnxruntime<2,>=1.14" in text
        assert "av>=11" in text

    def test_states_the_cudnn_9_and_driver_prerequisites(self):
        text = read(REQUIREMENTS_LOCK)
        assert "cuDNN 9" in text
        assert "530.41.03" in text
        assert "cudnn" in read(VERSIONS_ENV).lower(), (
            "the lock says cuDNN 9 comes from the base image; the base image must have it"
        )

    def test_does_not_leak_into_the_engine_core_dependencies(self):
        text = read(REQUIREMENTS_LOCK)
        assert "transcoding/pyproject.toml" in text, (
            "the lock must say out loud that it is not the engine's dependency set"
        )
        project = read(PYPROJECT)
        core = re.search(r"^dependencies = \[(.*?)\]", project, re.MULTILINE | re.DOTALL)
        assert core, "pyproject.toml no longer declares a core dependencies list"
        declared = core.group(1)
        assert declared.strip() == '"requests>=2.31"', (
            "the engine's core set grew — optional packages must stay optional "
            "(tests/test_engine_isolation.py imports the engine without them)"
        )
        for name in ("modal", "boto3", "faster-whisper", "ctranslate2",
                     "huggingface-hub", "tokenizers", "onnxruntime", "pillow", "groq"):
            assert f'"{name}' not in declared and f'"{name}==' not in declared, (
                f"{name} must not be a core dependency of the engine"
            )
        for name, version in lock_pins(text).items():
            assert version not in declared, (
                f"the core dependency list pins {name}=={version}; the lock is managed-image only"
            )


# ── the agent image ──────────────────────────────────────────────────────────
class TestDockerfileAgent:
    def test_is_ubuntu_2404(self):
        text = read(DOCKERFILE)
        assert re.search(r"^FROM ubuntu:24\.04\s*$", text, re.MULTILINE)
        assert "TARGET_UBUNTU_VERSION" in read(VERSIONS_ENV)

    def test_runs_the_shared_recipe_and_verifies_the_result(self):
        text = normalized(read(DOCKERFILE))
        assert "build_ffmpeg.sh" in text, (
            "the agent image must build FFmpeg with the shared recipe, not apt"
        )
        assert "verify_toolchain.sh" in text, (
            "a broken toolchain has to fail the build, not the first job"
        )
        # ...and the verification must run AFTER any purge, on the pruned image,
        # otherwise it proves nothing about what ships. rindex is the *invocation*
        # (the header comment mentions the script earlier).
        purge_at = text.index("apt-get purge")
        verify_at = text.rindex("verify_toolchain.sh")
        assert purge_at < verify_at, "verify_toolchain.sh runs before the apt purge"
        # A distribution ffmpeg must never be installed as a fallback. The check
        # is per *logical* command (a RUN block's backslash continuations), not
        # per line: the regex form used to run past the end of the command and
        # match an unrelated `FFMPEG_PREFIX` several lines later.
        for command in install_commands(text):
            assert not re.search(r"\bffmpeg\b", command), (
                "Dockerfile.agent installs distro ffmpeg — that build is what this replaced"
            )
        # No CUDA toolkit either: --enable-cuda-llvm is what makes the toolkit
        # unnecessary, and installing it would hide a broken clang path.
        assert "cuda-toolkit" not in text

    def test_installs_the_checksum_pinned_packager(self):
        text = normalized(read(DOCKERFILE))
        # The pin itself lives in versions.env; the Dockerfile must *use* it
        # rather than restate it, or the two can drift apart.
        assert "packager" in text
        assert "sha256sum -c -" in text
        assert "${SHAKA_SHA256}" in text
        assert "${SHAKA_URL}" in text
        assert SHAKA_SHA256 not in text, "the packager hash is duplicated in the Dockerfile"

    def test_runs_the_shared_recipe_with_bash(self):
        # The package lists are bash arrays; /bin/sh on Ubuntu is dash, and the
        # first image build failed exactly there.
        text = normalized(read(DOCKERFILE))
        assert 'SHELL ["/bin/bash"' in text
        assert ". /tmp/openvod-toolchain/versions.env" in text
        assert ". /tmp/openvod-toolchain/apt-packages.env" in text

    def test_makes_the_engine_readable_by_the_unprivileged_user(self):
        # The image runs as uid 10001. A module that arrives mode 600 (which is
        # what a restrictive umask on the build machine produces, since git only
        # tracks the executable bit) makes the CLI fail with PermissionError.
        text = normalized(read(DOCKERFILE))
        copy_at = text.index("COPY transcoding/ /app/")
        chmod_at = text.index("chmod -R a+rX /app")
        user_at = text.index("USER openvod")
        assert copy_at < chmod_at < user_at, (
            "the engine must be made world-readable before dropping privileges"
        )

    def test_installs_the_engine_without_optional_dependencies(self):
        text = normalized(read(DOCKERFILE))
        assert "--no-deps" in text and "-e /app" in text
        assert "venv" in text, "PEP 668: the system interpreter is externally managed"
        assert "requests" in text
        # python3-venv has to be installed after the purge: the purge takes
        # ensurepip with it, and `python3 -m venv` then fails at this step.
        purge_at = text.index("apt-get purge")
        venv_dep_at = text.index("install -y --no-install-recommends python3-venv")
        assert purge_at < venv_dep_at, "python3-venv is installed before the purge"

    def test_keeps_the_hardened_runtime_conventions(self):
        text = read(DOCKERFILE)
        assert "useradd --uid 10001" in text and "openvod" in text
        assert "groupadd --gid 44 video" in text
        assert 'ENTRYPOINT ["/usr/bin/tini", "--", "openvod-transcoder"]' in text
        assert 'VOLUME ["/var/lib/openvod-transcoder"]' in text
        assert "HEALTHCHECK" in text and "doctor" in text
        for env_var in ("OPENVOD_SCRATCH_DIR", "OPENVOD_JOURNAL", "OPENVOD_ROOTS_FILE"):
            assert env_var in text, f"the agent image lost {env_var}"
        assert re.search(r"^USER openvod\s*$", text, re.MULTILINE)

    def test_documents_the_runtime_hardware_paths(self):
        text = read(DOCKERFILE)
        assert "--gpus" in text and "capabilities=compute,utility,video" in text
        assert "/dev/dri/renderD128" in text and "--group-add video" in text
        assert "530.41.03" in text, "the driver floor the headers imply must be stated"


# ── CI: the real-media suites must not silently skip ─────────────────────────
class TestCiWorkflow:
    def test_transcoding_job_uses_python_312_and_installs_the_media_tools(self):
        text = normalized(read(CI_WORKFLOW))
        job = text.split("transcoding-python:", 1)[1].split("\n  docker-images:", 1)[0]
        assert "python-version: '3.12'" in job
        assert "ffmpeg" in job
        assert "packager" in job
        assert SHAKA_SHA256 in job, "CI must checksum-pin the packager it installs"

    def test_requires_the_media_tools_instead_of_skipping(self):
        text = normalized(read(CI_WORKFLOW))
        job = text.split("transcoding-python:", 1)[1].split("\n  docker-images:", 1)[0]
        assert 'OPENVOD_REQUIRE_MEDIA_TOOLS: "1"' in job, (
            "without this the real-media suites skip and a missing binary looks green"
        )


class TestConfigureFlagsExistInThePinnedRelease:
    """
    Every `--enable-*` in the recipe must be a real option of the pinned FFmpeg.

    This is a text check, not a build, but it catches the failure the first
    image build actually hit: `--enable-libvdpau` was removed upstream, and
    configure answered "Unknown option" after a full apt install and download.
    The FFmpeg configure source is fetched (and cached) rather than guessed at.

    Skipped when offline: without the source there is nothing to compare
    against, and a network-less run must not fail for that reason.
    """

    def _configure_text(self) -> str:
        import tempfile
        import urllib.request

        version = env_value(read(VERSIONS_ENV), "FFMPEG_VERSION")
        url = f"https://raw.githubusercontent.com/FFmpeg/FFmpeg/n{version}/configure"
        # Cached outside the repository and keyed by version: a version bump
        # fetches the new release's flags instead of validating against a stale
        # file, and no derived data lands in the working tree.
        cache = Path(tempfile.gettempdir()) / f"openvod-ffmpeg-{version}-configure-flags.txt"
        if cache.exists():
            return cache.read_text()
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                text = response.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001 — offline is a skip, not a failure
            pytest.skip(f"cannot fetch FFmpeg configure to validate flags: {exc}")
        flags = sorted(
            set(re.findall(r"--(?:enable|disable)-[a-z0-9][a-z0-9-]*", text))
        )
        cache.write_text("\n".join(flags) + "\n")
        return cache.read_text()

    def test_every_configure_flag_is_recognised(self):
        known = set(self._configure_text().split())

        def feature(flag: str) -> str:
            # `--enable-x` and `--disable-x` are two spellings of one feature,
            # and configure's help lists whichever spelling sets the default.
            match = re.match(r"--(?:enable|disable)-(.+)", flag)
            return match.group(1) if match else flag

        known_features = {feature(flag) for flag in known}
        recipe = read(BUILD_SCRIPT)
        used = set(re.findall(r"--(?:enable|disable)-[a-z0-9][a-z0-9-]*", recipe))
        unknown = sorted(flag for flag in used if feature(flag) not in known_features)
        assert unknown == [], f"FFmpeg {FFMPEG_VERSION} does not accept: {unknown}"

    def test_the_removed_libvdpau_option_is_not_used(self):
        assert "--enable-libvdpau" not in read(BUILD_SCRIPT)


# ── where the *container* finds the toolchain ────────────────────────────────
#
# The recipe tests above check that the image builds the right media tools. This
# one checks that the container can still start. The Modal CLI mounts `main.py`
# and `image_build.py` as loose files at /root, so `Path(__file__).parent` is
# /root there and `Path(__file__).parent / "toolchain"` does not exist; the
# directory lives only at the image's remote_path. A module-level read of the
# checkout path therefore passes every local check — `modal deploy` imports the
# file on the deploy machine, where the checkout path is the one that exists —
# and then fails to hydrate every function in the deployed app:
#
#   File "/root/main.py", line 110, in <module>
#     _BUILD_PACKAGES = read_package_list(_TOOLCHAIN_DIR / "apt-packages.env", ...)
#   FileNotFoundError: [Errno 2] '/root/toolchain/apt-packages.env'
#
# These are text/AST assertions on purpose: importing `main.py` would need the
# Modal SDK and construct the whole image, which is not what this guards.
class TestMountedSourcesFindTheToolchain:
    def test_module_parses_before_it_is_deployed(self):
        # `modal deploy` imports main.py on the deploy machine before it builds
        # anything, so a syntax error there is cheap to catch — but only if
        # something reads the file without importing it (importing needs the
        # Modal SDK and constructs the image).
        compile(read(MODAL_MAIN), str(MODAL_MAIN), "exec")
        compile(read(MODAL_IMAGE_BUILD), str(MODAL_IMAGE_BUILD), "exec")

    def test_image_mounts_the_toolchain_where_the_reader_looks(self):
        module = ast.parse(read(MODAL_MAIN))
        constants = module_string_constants(module)
        assert constants.get("_TOOLCHAIN_IN_IMAGE") == TOOLCHAIN_IN_IMAGE, (
            "main.py must pin the path the image bakes the toolchain to"
        )

        calls = [
            node
            for node in ast.walk(module)
            if isinstance(node, ast.Call)
            and dotted_name(node.func).endswith("add_local_dir")
        ]
        assert len(calls) == 1, "main.py should add the toolchain directory exactly once"
        keywords = {keyword.arg: keyword.value for keyword in calls[0].keywords}
        remote_path = keywords.get("remote_path")
        if isinstance(remote_path, ast.Name):
            remote_path = constants.get(remote_path.id)
        else:
            remote_path = getattr(remote_path, "value", None)
        assert remote_path == TOOLCHAIN_IN_IMAGE, (
            "the image build and the container-side reader must name one path"
        )
        assert getattr(keywords.get("copy"), "value", None) is True, (
            "copy=False defers the directory to a startup mount, which is not "
            "what a module-level reader can rely on"
        )

    def test_module_level_reads_never_target_the_checkout_path(self):
        # Only module-level statements count. Function bodies are entered after
        # the container has hydrated, so `image_build.read_package_list` (a
        # plain path-taking helper) is free to live there.
        offenders = []
        for path in (MODAL_MAIN, MODAL_IMAGE_BUILD):
            module = ast.parse(read(path))
            toolchain = checkout_toolchain_names(module)
            resolved = names_resolved_through_the_resolver(module)
            for statement in module.body:
                for node in ast.walk(statement):
                    if isinstance(node, ast.Call):
                        name = dotted_name(node.func).split(".")[-1]
                        if name == "read_package_list":
                            argument = node.args[0] if node.args else None
                            # The one shape that works in both places: read the
                            # path the resolver returned, not one computed from
                            # the mounted file's own location.
                            if not (isinstance(argument, ast.Name) and argument.id in resolved):
                                offenders.append(
                                    f"{path.name}: module-level read_package_list("
                                    f"{ast.unparse(argument) if argument else ''})"
                                    " — that path must come from"
                                    " resolve_toolchain_file(...)"
                                )
                        elif name == "resolve_toolchain_file":
                            for argument in node.args:
                                if path_names(argument) & toolchain:
                                    offenders.append(
                                        f"{path.name}: resolve_toolchain_file("
                                        f"{ast.unparse(argument)})"
                                    )
                    elif isinstance(node, ast.Attribute) and node.attr == "read_text":
                        if path_names(node.value) & toolchain:
                            offenders.append(
                                f"{path.name}: module-level "
                                f"{ast.unparse(node.value)}.read_text()"
                            )
        assert offenders == [], (
            "these run inside every container at import time, where the checkout "
            "path does not exist: " + "; ".join(offenders)
        )

    def test_image_build_module_reads_no_files_at_import(self):
        module = ast.parse(read(MODAL_IMAGE_BUILD))
        for statement in module.body:
            for node in ast.walk(statement):
                assert not (
                    isinstance(node, ast.Name) and node.id == "open"
                ), "image_build.py must not read the filesystem at import time"


def dotted_name(node: ast.AST) -> str:
    """`a.b.c` (and `a.b.c(...)`) as a dotted string; "" when unnameable."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted_name(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    if isinstance(node, ast.Call):
        return dotted_name(node.func)
    return ""


def module_string_constants(module: ast.Module) -> dict[str, str]:
    """Module-level `NAME = "literal"` assignments, for resolving indirection."""
    constants: dict[str, str] = {}
    for statement in module.body:
        if not isinstance(statement, ast.Assign) or not isinstance(statement.value, ast.Constant):
            continue
        for target in statement.targets:
            if isinstance(target, ast.Name) and isinstance(statement.value.value, str):
                constants[target.id] = statement.value.value
    return constants


def path_names(node: ast.AST) -> set[str]:
    """Names contributing to a string path expression, e.g. `_root / "toolchain"`."""
    names: set[str] = set()
    for part in node.elts if isinstance(node, ast.Tuple) else [node]:
        if isinstance(part, ast.Name):
            names.add(part.id)
        elif isinstance(part, ast.BinOp):
            names |= path_names(part.left) | path_names(part.right)
        elif isinstance(part, ast.Call):
            for argument in part.args:
                names |= path_names(argument)
    return names


def names_resolved_through_the_resolver(module: ast.Module) -> set[str]:
    """Module-level names assigned from `resolve_toolchain_file(...)`.

    `_APT_PACKAGES = resolve_toolchain_file("apt-packages.env")` is the shape
    that works in a container, so a later `read_package_list(_APT_PACKAGES, ...)`
    is reading a path that the container can actually satisfy.
    """
    resolved: set[str] = set()
    for statement in module.body:
        if not isinstance(statement, ast.Assign) or not isinstance(statement.value, ast.Call):
            continue
        if dotted_name(statement.value.func).endswith("resolve_toolchain_file"):
            resolved.update(
                target.id for target in statement.targets if isinstance(target, ast.Name)
            )
    return resolved


def checkout_toolchain_names(module: ast.Module) -> set[str]:
    """Module-level names bound to the *checkout's* toolchain directory.

    Seeded with `_root` and `__file__`, which in a container resolve to `/root`
    and have no `toolchain/` beside them. Aliases propagate, so
    `_TOOLCHAIN_DIR = _root / "toolchain"` makes `_TOOLCHAIN_DIR` count too —
    while `_TOOLCHAIN_IN_IMAGE = "/opt/openvod/toolchain"` deliberately does not,
    because that path is the one the image actually bakes.
    """
    names = {"_root", "__file__"}
    for _ in range(4):  # module-level aliasing chains are short; four is generous
        for statement in module.body:
            if not isinstance(statement, ast.Assign):
                continue
            targets = [t.id for t in statement.targets if isinstance(t, ast.Name)]
            if not targets:
                continue
            if path_names(statement.value) & names:
                names.update(targets)
    names.discard("__file__")
    return names
