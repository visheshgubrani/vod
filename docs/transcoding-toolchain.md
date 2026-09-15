# The transcoding toolchain

Both halves of the system — the Modal runner and the self-hosted agent — encode
with **one** FFmpeg, built from source by one recipe, pinned in one file. This
document says which versions, why they are pinned, how the images prove the
toolchain is intact, and what must be verified on real hardware before a release
is promoted.

## Pinned versions

Everything lives in `transcoding/toolchain/versions.env`; nothing else may
hard-code a version, URL or digest.

| Component | Version | Why this one |
| --- | --- | --- |
| FFmpeg / ffprobe | 9.0.1 (release tarball, sha256-pinned) | current stable; the release whose `scale_cuda` has the `format` option the NVIDIA scaling path needs |
| nv-codec-headers | `n12.1.14.0` (commit-pinned) | the release FFmpeg 9.0.1's configure accepts (`ffnvcodec >= 12.1.14.0`); its README documents the Linux driver floor of 530.41.03 that the NVENC path inherits |
| Shaka Packager | 3.2.0 (sha256-pinned) | unchanged; a packager that silently changes version changes every job's bytes |
| Modal base image | `nvidia/cuda:12.9.2-cudnn-runtime-ubuntu24.04`, pinned by manifest digest | CUDA 12 + cuDNN 9 for faster-whisper's CTranslate2 backend, on Ubuntu 24.04 |
| Agent base image | `ubuntu:24.04` | the managed OS, with the distribution's Python 3.12 |
| Python (managed images) | 3.12 | one interpreter generation on both sides of the seam |

Ubuntu 24.04 LTS is under standard maintenance until May 2029. Whisper's Python
dependencies are exact pins in `transcoding/toolchain/requirements-managed.lock`
and stay out of the engine's core dependency set (`pyproject.toml` declares only
`requests`), which is what keeps the engine importable on a machine with no
CUDA, no Modal and no Whisper.

## Why FFmpeg is built rather than installed

The failure that started this work: the deployment's FFmpeg rejected
`scale_cuda`'s `format` option. That is a property of how FFmpeg's CUDA filters
were compiled, so no amount of runtime detection or argument juggling fixes it —
either the option exists in the binary or the filter path cannot use it. The
recipe therefore:

- builds the CUDA filters with clang (`--enable-cuda-llvm`). FFmpeg's configure
  runs clang as `nvcc` with `--cuda-device-only -nocudainc -nocudalib`, so the
  device code is compiled to PTX and **no CUDA toolkit is needed to build**;
  the driver is reached by `dlopen` at runtime, which is exactly why hardware
  usability is a runtime probe and never a build-time assertion;
- targets `sm_75` explicitly. FFmpeg's own default (`sm_30`) is not supported by
  modern clang, and PTX is forward-compatible: newer drivers JIT it;
- includes NVENC/NVDEC, VAAPI, libx264, libdav1d, Opus and zscale support, and
  links the distribution's codec libraries rather than vendoring them;
- writes a build manifest (`share/clipmux/toolchain.json`) with the versions,
  hashes, the exact configure line and the `ldd` inventory, and ships FFmpeg's
  licence files plus a NOTICE naming each source URL.

The engine no longer *depends* on that option either: the hybrid NVENC path uses
software scaling and lets NVENC upload the frames, so a host whose CUDA filters
are unusable still gets hardware encoding.

## What the image builds prove

Both images run `toolchain/verify_toolchain.sh` as a build step. It fails the
build — not the first job — unless all of the following hold:

- `ffmpeg -version` reports exactly the pinned version, built with
  `--enable-cuda-llvm`/libdav1d/libzimg;
- the required encoders (`libx264`, `h264_nvenc`, `hevc_nvenc`, `h264_vaapi`),
  decoders (`h264`, `hevc`, `libdav1d`, `vp9`, `aac`, `opus`), hwaccels
  (`cuda`, `vaapi`) and filters (`scale_cuda`, `scale_vaapi`, `zscale`,
  `hwupload`, `hwupload_cuda`, `tonemap`, `loudnorm`) are present;
- `ffmpeg -h filter=scale_cuda` lists the **`format` option** — the exact
  capability whose absence caused the reported failure;
- a real two-frame `libx264` encode runs and ffprobe reads it back.

`transcoding/tests/test_toolchain_recipe.py` re-checks the recipe's pins, its
flag list against the pinned release's configure script, and the lockfile, so a
renamed or removed option fails the fast suite instead of a 15-minute image
build.

## Where the recipe lives (two paths, and only one exists at runtime)

The same directory has a different path before and after deployment, and the
difference is load-bearing:

| Context | Path | How it gets there |
| --- | --- | --- |
| Deploy machine / `modal run` / tests | `transcoding/toolchain/` | the checkout |
| Modal container | `/opt/clipmux/toolchain` | `main.py`'s `add_local_dir(..., remote_path=_TOOLCHAIN_IN_IMAGE, copy=True)`, an image layer |
| Self-hosted agent image | `/opt/clipmux/toolchain` | `Dockerfile.agent` copies four recipe files there |
| Relocated copy (opt-in) | `$CLIPMUX_TOOLCHAIN_DIR` | for a build from elsewhere; searched first |

Inside a container the Modal CLI mounts `main.py` and `image_build.py` as
**loose files at `/root`**, so `Path(__file__).parent / "toolchain"` is empty
there. Reading the checkout path unconditionally therefore passes on the deploy
machine — `modal deploy` imports the file, finds it, and builds the image — and
then fails to hydrate *every* function of the deployed app once a container
starts:

```
File "/root/main.py", line 110, in <module>
  _BUILD_PACKAGES = read_package_list(_TOOLCHAIN_DIR / "apt-packages.env", ...)
FileNotFoundError: [Errno 2] '/root/toolchain/apt-packages.env'
```

`image_build.resolve_toolchain_file` is the only sanctioned way to read the
recipe, and it resolves in the order above. `tests/test_review_regressions.py`
imports the module from a simulated `/root`, and
`tests/test_toolchain_recipe.py` rejects any module-level read that targets the
mounted file's own directory — so this class of failure is caught by the fast
suite rather than by a deploy.

## Runner configuration

The engine decides *which* path a rendition takes; the runner decides how much
it may spend. The Modal worker sets these explicitly (each is an env override, so
an operator can change them without editing code), and they are additive
`ProcessingOptions` fields — a self-hosted agent keeps its operator's values
unless it sets them itself.

| Variable / option | Default | Meaning |
| --- | --- | --- |
| `TRANSCODE_RENDITION_CONCURRENCY` (`rendition_concurrency`) | 3 | renditions encoded at once |
| `TRANSCODE_CPU_RENDITION_CONCURRENCY` (`cpu_rendition_concurrency`) | 1 | how many CPU renditions may run at once. Enforced at *encode* time, not only when the chain is CPU-only: a GPU rendition that falls back to the CPU takes the same slot, so three GPU workers falling back together cannot start three concurrent x264 encodes. `0` disables the separate bound and leaves the operator's `rendition_concurrency` in charge (the self-hosted default). |
| `TRANSCODE_CPU_THREADS` (`cpu_ffmpeg_threads`) | 4 | thread budget for a CPU rendition: decoder threads (`-threads`), filter threads (`-filter_threads`) and the output encoder (`-threads:v`) |
| `TRANSCODE_HYBRID_THREADS` (`hybrid_ffmpeg_threads`) | 2 | the same three bounds for a hybrid rendition, whose decode and scale are the software half of the work |
| `TRANSCODE_AUDIO_THREADS` (`audio_ffmpeg_threads`) | 1 | decoder, filter and encoder bounds (`-threads:a`) for the audio encode |

A bound of `0` means "let FFmpeg decide" and removes the flags entirely; the
placement is pinned by a real-media test, because FFmpeg *ignores* options that
follow the output path rather than rejecting them.

The Modal GPU worker requests 4 CPU cores with an 8-core limit and 16 GiB of
memory: enough for three GPU renditions plus a same-worker software fallback,
bounded so a CPU-only job cannot starve the container.

## Release gates

These require real hardware and cannot be replaced by mocks. `doctor --full`
(agent) and a Modal deployment run are the vehicles.

| Gate | What it proves |
| --- | --- |
| Modal L4, `encoder_backend=auto`, ordinary source | the full-GPU path is used and the rendition's `mode` is `gpu` |
| Modal L4, forced fallback (e.g. `TRANSCODE_ENCODER=nvenc` with the CUDA filter path disabled) | the hybrid path is used, the job still completes, and `fallbacks` explains why |
| Modal L4 / self-hosted VAAPI with a non-zero thread bound (both are set by default: 2 and 2) | a **hardware** encoder accepts the output-side `-threads:v` bound. FFmpeg ignores an option it cannot place, and `h264_nvenc`/`h264_vaapi` do not document `-threads`, so this is the only place that can settle whether the bound is applied or merely tolerated. The local suite can only prove the flag positions for `libx264`/AAC. |
| Self-hosted NVIDIA | `doctor --full` reports NVENC verified; a job reports `backend=nvenc` |
| Self-hosted VAAPI | `doctor --full` reports VAAPI verified; a job reports `backend=vaapi` |
| Self-hosted CPU-only | a job completes on `libx264` and reverts to CPU concurrency/thread bounds (a real encode at a non-zero bound is covered by the real-media suite) |
| Retry of the originally reported file | the source that produced the `scale_cuda` failure completes on the new image |
| Driver floor | an NVIDIA driver >= 530.41.03 loads the compiled NVENC path (checked at runtime, never at build time) |

## Rollout

1. **Canary** the new Modal deployment and agent image against the media matrix
   (`transcoding/tests/test_real_media.py` shapes: AV1/Opus WebM, VP9 WebM,
   H.264, HEVC 10-bit, HDR, rotated, 4:2:2/4:4:4, VFR, short, silent,
   audio-only).
2. Compare against the previous deployment: completion rate, fallback reasons
   (`processing.fallbacks`), per-rendition `backend`/`mode` and `seconds`,
   resource use, subtitle results, and playback quality of the packaged HLS/DASH.
3. Promote only when the canary has no unexplained fallbacks and no rendition
   reports a backend it should not have used.
4. **Rollback**: the previous Modal deployment and the previous agent image
   reference are retained. `SELF_HOSTED_ENABLED=false` stops new local
   submissions without cancelling anything; a Modal rollback is a redeploy of the
   previous version. Completed videos, playback URLs and storage layouts are
   untouched by either — the processing plan version (`PROCESSING_PLAN_VERSION`)
   only invalidates *reusable intermediates*, never published output.

Defaults agreed for this rollout: both runtimes upgraded, Ubuntu 24.04,
FFmpeg 9.0.1, CPU fallback inside the same worker and attempt, and GPU
transformations only where they have been validated. Output-codec expansion, new
quality ladders, GPU HDR development and cross-worker handoff are explicitly out
of scope.
