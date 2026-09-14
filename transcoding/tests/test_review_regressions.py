"""Behavioral regressions found while reviewing the toolchain migration."""
import threading
import time
import os
import sys
import shutil
from pathlib import Path

import pytest

from tests.test_pipeline import (
    patched, source, metadata_for, FakeFfmpeg, report_with, run_with, verified,
    device_error, cuda_filter_error, session_error,
)
from openvod_transcoder import pipeline
from openvod_transcoder.encoding.failures import build_process_error
from openvod_transcoder.errors import TranscodeError


def test_cpu_limit_applies_after_concurrent_gpu_fallback(tmp_path, source, patched, monkeypatch):
    patched["metadata"] = metadata_for(has_audio=False)
    patched["probes"] = {"nvenc": verified()}
    rendezvous = threading.Barrier(3)
    lock = threading.Lock()
    active = peak = 0

    def encode(**kwargs):
        nonlocal active, peak
        if kwargs["candidate"].backend.is_hardware:
            rendezvous.wait(timeout=3)
            raise device_error()
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            time.sleep(0.1)
            kwargs["output_path"].write_bytes(b"encoded" * 500)
            return kwargs["output_path"]
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(pipeline, "_encode_rendition", encode)
    run_with(patched, tmp_path, source, report_with(nvenc=True),
             rendition_concurrency=3, cpu_rendition_concurrency=1)
    assert peak == 1


def test_session_retry_waits_for_running_gpu_encode(tmp_path, source, patched, monkeypatch):
    patched["metadata"] = metadata_for(has_audio=False)
    patched["probes"] = {"nvenc": verified()}
    running = threading.Event()
    retry_requested = threading.Event()
    finished = threading.Event()
    attempted = 0
    retry_overlapped = []

    def encode(**kwargs):
        nonlocal attempted
        label = kwargs["spec"].label
        if label == "1080p":
            running.set()
            assert retry_requested.wait(3)
            time.sleep(0.15)
            finished.set()
        elif label == "720p":
            attempted += 1
            if attempted == 1:
                assert running.wait(3)
                retry_requested.set()
                raise session_error()
            retry_overlapped.append(not finished.is_set())
        kwargs["output_path"].write_bytes(b"encoded" * 500)
        return kwargs["output_path"]

    monkeypatch.setattr(pipeline, "_encode_rendition", encode)
    run_with(patched, tmp_path, source, report_with(nvenc=True), rendition_concurrency=2)
    assert retry_overlapped == [False]


@pytest.mark.parametrize("close_stdout", [True, False])
def test_watchdog_cleans_up_after_stdout_eof_or_callback_error(close_stdout):
    from openvod_transcoder.ffmpeg_progress import run_ffmpeg, StallPolicy, StallError
    script = ("import os,time; os.close(1); time.sleep(1)" if close_stdout else
              "import time; print('frame=1\\nprogress=continue', flush=True); time.sleep(1)")
    def callback(*_):
        raise ValueError("progress sink failed")
    started = time.monotonic()
    with pytest.raises(StallError if close_stdout else ValueError):
        run_ffmpeg([sys.executable, "-c", script], label="cleanup-regression",
                   on_progress=callback, stall=StallPolicy(timeout_seconds=0.1), poll_interval=0.01)
    assert time.monotonic() - started < 0.7


def test_terminal_failure_waits_for_sibling_cleanup(tmp_path, source, patched, monkeypatch):
    from openvod_transcoder.errors import CancelledError
    patched["metadata"] = metadata_for(has_audio=False)
    entered = threading.Event()
    stopped = threading.Event()
    def encode(**kwargs):
        if kwargs["spec"].label == "1080p":
            assert entered.wait(3)
            raise TranscodeError("TRANSCODE_FAILED", "bad media")
        entered.set()
        assert kwargs["token"].wait(3)
        time.sleep(0.1)  # process termination/reaping
        stopped.set()
        raise CancelledError()
    monkeypatch.setattr(pipeline, "_encode_rendition", encode)
    with pytest.raises(TranscodeError, match="bad media"):
        run_with(patched, tmp_path, source, report_with(), rendition_concurrency=2)
    assert stopped.is_set(), "caller must not delete work files while an encoder is using them"


def test_disk_failure_after_gpu_fallback_keeps_its_error_code(tmp_path, source, patched):
    patched["metadata"] = metadata_for(has_audio=False)
    patched["probes"] = {"nvenc": verified()}
    disk = build_process_error(stderr="No space left on device", returncode=1, operation="encode")
    patched["ffmpeg"] = FakeFfmpeg(
        patched["metadata"], behavior=lambda label, attempt, cmd:
        cuda_filter_error() if label.endswith("-nvenc") else disk)
    with pytest.raises(TranscodeError) as caught:
        run_with(patched, tmp_path, source, report_with(nvenc=True))
    assert caught.value.code == "INSUFFICIENT_DISK"


def test_thread_budget_bounds_output_encoder_and_filters(tmp_path, source, patched):
    run_with(patched, tmp_path, source, report_with(), cpu_ffmpeg_threads=4, audio_ffmpeg_threads=2)
    video = next(cmd for cmd in patched["ffmpeg"].commands if cmd[-1].endswith("video_1080p.mp4"))
    audio = next(cmd for cmd in patched["ffmpeg"].commands if cmd[-1].endswith("audio.mp4"))
    assert video[video.index("-threads:v") + 1] == "4"
    assert audio[audio.index("-threads:a") + 1] == "2"
    assert video[video.index("-filter_threads") + 1] == "4"
    assert audio[audio.index("-filter_threads") + 1] == "2"


@pytest.mark.parametrize("gpu_decode", [True, False])
def test_nvenc_device_is_bound_on_output(gpu_decode):
    from openvod_transcoder.encoding.backends import build_video_command, backend_named, RenderSpec
    cmd = build_video_command(ffmpeg="ffmpeg", input_path="source.mp4", output_path="out.mp4",
        backend=backend_named("nvenc:1"), spec=RenderSpec("480p", 854, 480, "1M", "2M", "4M", 25),
        metadata=metadata_for(), segment_duration=4, gpu_decode=gpu_decode)
    assert "-gpu" not in cmd[:cmd.index("-i")]
    assert cmd[cmd.index("-gpu") + 1] == "1"


def test_missing_hls_initialization_reference_is_rejected(tmp_path):
    from openvod_transcoder.encoding.validation import validate_manifest_references
    (tmp_path / "playlist.m3u8").write_text('#EXTM3U\n#EXT-X-MAP:URI="absent.mp4"\n')
    with pytest.raises(TranscodeError, match="absent.mp4"):
        validate_manifest_references(tmp_path)


def test_missing_dash_middle_segment_is_rejected(tmp_path):
    from openvod_transcoder.encoding.validation import validate_manifest_references
    (tmp_path / "manifest.mpd").write_text('''<MPD><Period><AdaptationSet><Representation>
        <SegmentTemplate media="$Number$.m4s" startNumber="1"><SegmentTimeline>
        <S t="0" d="1000" r="2"/></SegmentTimeline></SegmentTemplate>
        </Representation></AdaptationSet></Period></MPD>''')
    (tmp_path / "1.m4s").write_bytes(b"segment")
    (tmp_path / "3.m4s").write_bytes(b"segment")
    with pytest.raises(TranscodeError, match="2.m4s"):
        validate_manifest_references(tmp_path)


def test_dash_base_url_and_nonzero_start_time_are_resolved(tmp_path):
    from openvod_transcoder.encoding.validation import validate_manifest_references
    (tmp_path / "manifest.mpd").write_text('''<MPD><Period><AdaptationSet>
        <BaseURL>video/</BaseURL><SegmentTemplate media="$RepresentationID$-$Time$.m4s"
        initialization="init.mp4"><SegmentTimeline><S t="100" d="20" r="1"/>
        </SegmentTimeline></SegmentTemplate><Representation id="v1"/>
        </AdaptationSet></Period></MPD>''')
    (tmp_path / "video").mkdir()
    for name in ("init.mp4", "v1-100.m4s", "v1-120.m4s"):
        (tmp_path / "video" / name).write_bytes(b"data")
    validate_manifest_references(tmp_path)


def test_child_cancellation_does_not_leave_a_watcher_per_completed_job():
    from openvod_transcoder.cancellation import CancellationToken
    before = set(threading.enumerate())
    parent = CancellationToken()
    child = parent.child()
    try:
        assert not (set(threading.enumerate()) - before)
        child.cancel("stage finished")
        assert not parent.cancelled
        other = parent.child()
        parent.cancel("lease lost")
        assert other.wait(0.2)
        assert other.reason == "lease lost"
    finally:
        parent.cancel()


def test_hardware_decode_failure_is_not_misclassified_by_generic_media_footer():
    error = build_process_error(stderr=(
        "[h264 @ 0x1] Failed setup for format cuda: hwaccel initialisation returned error.\n"
        "Error while decoding stream #0:0: Invalid argument"), returncode=1, operation="encode")
    assert error.failure_kind == "decode"


def test_missing_nvenc_driver_library_allows_cpu_fallback():
    error = build_process_error(stderr="[h264_nvenc @ 0x1] Cannot load libnvidia-encode.so.1",
                                returncode=1, operation="encode")
    assert error.failure_kind == "device"


def test_generic_thread_setting_invalidates_reusable_encodes():
    from openvod_transcoder.options import ProcessingOptions
    assert (ProcessingOptions(ffmpeg_threads=1).plan_fingerprint()
            != ProcessingOptions(ffmpeg_threads=8).plan_fingerprint())


# ── the toolchain is at two paths, and a container only has one of them ──────
#
# The image bakes `transcoding/toolchain/` at a *remote* path
# (`add_local_dir(..., remote_path="/opt/openvod/toolchain", copy=True)`), while
# `main.py` and `image_build.py` are mounted as loose files at `/root`. So
# `Path(__file__).parent / "toolchain"` is empty in the container, and a
# module-level read of it kills hydration for every function in the app — the
# deployed container failed exactly there:
#
#   File "/root/main.py", line 110, in <module>
#     _BUILD_PACKAGES = read_package_list(_TOOLCHAIN_DIR / "apt-packages.env", ...)
#   FileNotFoundError: [Errno 2] '/root/toolchain/apt-packages.env'
#
# Deploying locally cannot catch it: on the deploy machine the checkout path is
# the one that exists. These tests pin the resolver that closes the gap.
def test_toolchain_file_resolves_beside_the_module_at_deploy_time():
    from image_build import resolve_toolchain_file

    # `modal deploy` imports main.py from the checkout, where `toolchain/` is a
    # sibling directory. If this breaks, every deploy reads no package lists.
    resolved = resolve_toolchain_file("apt-packages.env")
    assert resolved == Path(__file__).resolve().parent.parent / "toolchain" / "apt-packages.env"


def test_toolchain_file_resolves_in_a_container_layout(tmp_path, monkeypatch):
    from image_build import TOOLCHAIN_IN_IMAGE, resolve_toolchain_file, toolchain_root

    # Reproduce the container: the source file is mounted at a path with no
    # sibling `toolchain/` (that is what `/root` is), and the recipe exists only
    # where the image baked it.
    assert toolchain_root("/root/main.py") == Path("/root")
    assert toolchain_root("/root/image_build.py") == Path("/root")

    baked = tmp_path / "opt" / "openvod" / "toolchain"
    baked.mkdir(parents=True)
    (baked / "apt-packages.env").write_text("OPENVOD_BUILD_PACKAGES=(\n  clang\n)\n")

    monkeypatch.delenv("OPENVOD_TOOLCHAIN_DIR", raising=False)
    # module_file + roots ARE the container: a source file whose parent has no
    # toolchain/, and the recipe where add_local_dir's remote_path put it.
    resolved = resolve_toolchain_file(
        "apt-packages.env", module_file="/root/main.py", roots=(baked,)
    )
    assert resolved == baked / "apt-packages.env"
    # Where the image build writes must be where the reader falls back to, or
    # this fix is only a rename.
    assert str(TOOLCHAIN_IN_IMAGE) == "/opt/openvod/toolchain"


def test_toolchain_file_honours_an_explicit_relocated_recipe(tmp_path, monkeypatch):
    from image_build import read_package_list, resolve_toolchain_file

    # Real content, relocated: invented package names would not catch a parser
    # that has drifted from apt-packages.env's actual syntax.
    source = Path(__file__).resolve().parent.parent / "toolchain" / "apt-packages.env"
    relocated = tmp_path / "toolchain"
    relocated.mkdir()
    (relocated / "apt-packages.env").write_text(source.read_text(encoding="utf-8"))

    monkeypatch.setenv("OPENVOD_TOOLCHAIN_DIR", str(relocated))
    resolved = resolve_toolchain_file("apt-packages.env")
    assert resolved == relocated / "apt-packages.env"
    assert "clang" in read_package_list(resolved, "OPENVOD_BUILD_PACKAGES")
    assert "libx264-164" in read_package_list(resolved, "OPENVOD_RUNTIME_PACKAGES")


def test_missing_toolchain_file_names_every_path_it_tried(tmp_path, monkeypatch):
    from image_build import resolve_toolchain_file

    empty = tmp_path / "nothing-here"
    empty.mkdir()
    monkeypatch.delenv("OPENVOD_TOOLCHAIN_DIR", raising=False)
    with pytest.raises(FileNotFoundError) as excinfo:
        resolve_toolchain_file(
            "apt-packages.env", module_file="/root/main.py", roots=(empty,)
        )

    message = str(excinfo.value)
    assert "apt-packages.env" in message
    assert "/root/toolchain/apt-packages.env" in message
    assert str(empty / "apt-packages.env") in message, (
        "a bare ENOENT is what made the deployed failure hard to read"
    )


def test_image_build_hydrates_in_a_container_layout(tmp_path):
    """The end-to-end shape: import the mounted module from a /root that holds
    nothing but the source file, with the recipe only where the image baked it.

    A subprocess, because the point is *this file* imported from *that* path —
    the same two-path split that failed in the deployed container.
    """
    import subprocess

    tests_dir = Path(__file__).resolve().parent
    source_root = tests_dir.parent

    mounted_root = tmp_path / "root"
    mounted_root.mkdir()
    shutil.copy(source_root / "image_build.py", mounted_root / "image_build.py")
    baked = tmp_path / "opt" / "openvod" / "toolchain"
    baked.mkdir(parents=True)
    shutil.copy(source_root / "toolchain" / "apt-packages.env", baked / "apt-packages.env")

    probe = "\n".join([
        "import pathlib",
        "import image_build",
        f"image_build.TOOLCHAIN_IN_IMAGE = pathlib.Path({str(baked)!r})",
        "path = image_build.resolve_toolchain_file('apt-packages.env')",
        "build = image_build.read_package_list(path, 'OPENVOD_BUILD_PACKAGES')",
        "runtime = image_build.read_package_list(path, 'OPENVOD_RUNTIME_PACKAGES')",
        "print(len(build), len(runtime))",
    ])
    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=mounted_root,
        env={
            **os.environ,
            "PYTHONPATH": str(mounted_root),
            # Empty on purpose: an override pointing anywhere else would mask the
            # fallback this test exists to exercise.
            "OPENVOD_TOOLCHAIN_DIR": "",
        },
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    build_count, runtime_count = (int(n) for n in result.stdout.split())
    # Real lists, so a resolvable-but-empty read cannot pass.
    assert build_count > 10 and runtime_count > 10
