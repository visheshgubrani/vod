"""
The shared processing pipeline.

This is the orchestration that used to live inside Modal's worker function.
Extracting it is what lets the same encode run in two places without forking the
video lifecycle: the Modal runner and the self-hosted agent both call
:func:`run_pipeline` and both produce a :class:`PipelineResult` that the same
server-side finalizer accepts.

What the engine owns: probing, rendition planning, encoding, audio processing,
optional enrichment, packaging, output validation, and the artifact inventory.

What it does not own, and takes as a seam instead:

- **Execution** — the caller supplies ``work_dir`` and drives the lifecycle.
- **Encoding** — chosen through :mod:`openvod_transcoder.encoding` from a
  capability report, not from an environment variable read deep in a helper.
- **Transfer** — the caller supplies a transfer; the engine never reads storage
  credentials. This is what makes "the agent holds no R2 keys" structural
  rather than a promise.

The module imports without Modal, CUDA, boto3 or Whisper: optional dependencies
load inside the code path that needs them, so `import openvod_transcoder` works
on a bare machine.
"""
from __future__ import annotations

import shutil
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

from openvod_transcoder.cancellation import CancellationToken
from openvod_transcoder.config import R2_PREFIX
from openvod_transcoder.encoding.backends import (
    EncoderBackend,
    RenderSpec,
    build_audio_command,
    build_video_command,
)
from openvod_transcoder.encoding.probe import CapabilityReport, detect_capabilities
from openvod_transcoder.encoding.selection import (
    BackendCandidate,
    FallbackState,
    describe_chain,
    select_chain,
)
from openvod_transcoder.errors import (
    ERROR_AUDIO_ONLY_UNSUPPORTED,
    ERROR_EMPTY_FILE,
    ERROR_MISSING_RENDITION,
    ERROR_PACKAGING_FAILED,
    ERROR_UNSUPPORTED_HDR,
    ERROR_ENCODER_FAILED,
    CancelledError,
    TranscodeError,
)
from openvod_transcoder.ffmpeg_progress import StallPolicy, run_ffmpeg
from openvod_transcoder.options import ProcessingOptions
from openvod_transcoder.packaging import choose_segment_duration, package_with_shaka
from openvod_transcoder.planning import plan_audio, plan_renditions
from openvod_transcoder.progress import (
    STAGE_ANALYZE,
    STAGE_COMPLETE,
    STAGE_PACKAGE,
    STAGE_SNAPSHOT,
    STAGE_TRANSCODE,
    STAGE_UPLOAD,
    STAGE_VERIFY,
    NullProgress,
    ProgressSink,
    ProgressUpdate,
    RenditionProgress,
)
from openvod_transcoder.result import (
    Artifact,
    EnrichmentStatus,
    PipelineResult,
    ProcessingMetadata,
    RenditionReport,
    build_inventory,
)
from openvod_transcoder.snapshot import SourceSnapshot
from openvod_transcoder.transfer import ArtifactTransfer, TransferStats
from openvod_transcoder.utils.cmd import run_cmd
from openvod_transcoder.video.analysis import VideoMetadata, get_video_metadata, parse_ffprobe

# Codes where a different *encode* attempt cannot plausibly help. Anything not
# listed is treated as fallback-eligible only if `is_fallback_eligible` says so.
#
# This list is documentation as much as code: it is the answer to "why didn't it
# just retry on the CPU?" for every failure an owner is likely to see.
NON_FALLBACK_CODES = (
    ERROR_EMPTY_FILE,
    ERROR_AUDIO_ONLY_UNSUPPORTED,
    ERROR_UNSUPPORTED_HDR,
)


def run_pipeline(
    source_path: Path,
    work_dir: Path,
    options: ProcessingOptions,
    capabilities: Optional[CapabilityReport] = None,
    report_progress: Optional[ProgressSink] = None,
    cancellation: Optional[CancellationToken] = None,
    *,
    snapshot: Optional[SourceSnapshot] = None,
    transfer: Optional[ArtifactTransfer] = None,
    already_uploaded: frozenset[str] = frozenset(),
    ffmpeg: str = "ffmpeg",
    packager: str = "packager",
    keep_work_dir: bool = False,
    reusable: Optional[Dict[str, str]] = None,
    on_rendition: Optional[Callable[[str, Path], None]] = None,
) -> PipelineResult:
    """
    Encode, package and (optionally) transfer one source.

    ``snapshot`` lets a self-hosted agent hand in the immutable copy it took
    before the job started; when absent the engine encodes ``source_path``
    directly, which is what the Modal path does (its input is a fresh download in
    an ephemeral container, so it is already immutable).

    ``reusable`` maps rendition label → an already-encoded file from a previous
    attempt on this machine. It is the resume path, and it only exists because
    the *caller* validated the source hash and plan fingerprint: reusing a
    rendition encoded from different bytes, or under a different ladder, would
    produce a package that mixes two encodes.

    ``on_rendition`` is called the moment a rendition finishes, before packaging
    and long before upload. That ordering is the point: a job that fails during
    transfer must be able to resume without re-encoding, and recording renditions
    only after the whole pipeline returns (including upload) meant nothing was
    ever recorded when it mattered most.
    """
    progress = report_progress or NullProgress()
    token = cancellation or CancellationToken()
    reusable_renditions = dict(reusable or {})
    report = capabilities or detect_capabilities(ffmpeg=ffmpeg, shaka=packager, probe=False)

    work_dir = Path(work_dir)
    fmp4_dir = work_dir / "fmp4"
    output_dir = work_dir / "output"
    timings: Dict[str, float] = {}

    if work_dir.exists():
        shutil.rmtree(work_dir, ignore_errors=True)
    fmp4_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    token.raise_if_cancelled()

    # ── analyze ──────────────────────────────────────────────────────────────
    progress.report(ProgressUpdate(stage=STAGE_SNAPSHOT, fraction=1.0 if snapshot else 0.0,
                                   detail=snapshot.method if snapshot else "direct input"))
    started = time.monotonic()
    progress.report(ProgressUpdate(stage=STAGE_ANALYZE, fraction=0.1))
    metadata = get_video_metadata(str(source_path))
    if source_path.stat().st_size <= 1024:
        raise TranscodeError(
            ERROR_EMPTY_FILE,
            f"source is {source_path.stat().st_size} bytes — empty or truncated input",
        )
    timings["analyze"] = time.monotonic() - started

    if not metadata.has_video and options.extract_audio_only:
        pass  # falls through to the audio-only path below
    elif not metadata.has_video:
        # Audio-only remains supported (the plan keeps it): no video renditions,
        # just the normalized audio track and a DASH/HLS package of it.
        print("[PIPELINE] audio-only source — encoding audio track only")

    if metadata.is_hdr:
        _assert_hdr_supported(metadata)

    specs = plan_renditions(
        metadata,
        policy=options.rendition_policy,
        max_height=options.max_height,
        include_heights=options.resolved_heights(),
    )
    audio_plan = plan_audio(_probe_streams(source_path))

    progress.report(
        ProgressUpdate(
            stage=STAGE_ANALYZE,
            fraction=1.0,
            detail=f"{metadata.width}x{metadata.height} {metadata.fps:.2f}fps",
        )
    )
    token.raise_if_cancelled()

    # ── poster (nonfatal enrichment) ─────────────────────────────────────────
    enrichments: Dict[str, EnrichmentStatus] = {}
    poster_generated = False
    if metadata.has_video:
        try:
            from openvod_transcoder.video.poster import generate_poster

            generate_poster(str(source_path), str(output_dir / "poster.jpg"), metadata.duration)
            poster_generated = True
        except CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a missing poster is not a failed job
            print(f"[PIPELINE] poster generation failed (nonfatal): {exc}")

    # ── encode ───────────────────────────────────────────────────────────────
    started = time.monotonic()
    encoded, audio_path, backend_used, fallbacks = _encode_all(
        source_path=source_path,
        fmp4_dir=fmp4_dir,
        output_dir=output_dir,
        specs=specs,
        metadata=metadata,
        options=options,
        report=report,
        audio_plan=audio_plan,
        progress=progress,
        token=token,
        ffmpeg=ffmpeg,
        reusable=reusable_renditions,
        on_rendition=on_rendition,
    )
    timings["transcode"] = time.monotonic() - started

    # ── enrichment: subtitles and chapters (both opt-in, both nonfatal) ──────
    enrichments["subtitles"] = _run_transcription(
        source_path, output_dir, metadata, options, token=token
    )
    enrichments["chapters"] = _run_chapters(
        output_dir, metadata, options, enrichments["subtitles"]
    )

    # ── package ──────────────────────────────────────────────────────────────
    token.raise_if_cancelled()
    started = time.monotonic()
    progress.report(ProgressUpdate(stage=STAGE_PACKAGE, fraction=0.1))
    segment_duration = options.segment_duration or choose_segment_duration(metadata.duration)
    streams: Dict[str, Path] = {spec.label: encoded[spec.label] for spec in specs if spec.label in encoded}
    if audio_path is not None:
        streams["audio"] = audio_path
    if not streams:
        raise TranscodeError(
            ERROR_MISSING_RENDITION,
            "nothing to package: no video rendition and no audio track were produced",
        )
    try:
        package_with_shaka(streams, output_dir, segment_duration=segment_duration)
    except TranscodeError:
        raise
    except Exception as exc:
        raise TranscodeError(ERROR_PACKAGING_FAILED, f"packaging failed: {exc}") from exc
    timings["package"] = time.monotonic() - started

    # fMP4 intermediates are dead once Shaka has written its segments.
    shutil.rmtree(fmp4_dir, ignore_errors=True)

    # ── validate ─────────────────────────────────────────────────────────────
    progress.report(ProgressUpdate(stage=STAGE_VERIFY, fraction=0.1))
    artifacts = build_inventory(output_dir)
    _validate_package(artifacts, specs, audio_path is not None)

    # ── transfer ─────────────────────────────────────────────────────────────
    transfer_stats = TransferStats(total=len(artifacts))
    if transfer is not None:
        started = time.monotonic()
        progress.report(ProgressUpdate(stage=STAGE_UPLOAD, fraction=0.05))
        transfer_stats = transfer.upload_artifacts(
            output_dir,
            [artifact.path for artifact in artifacts],
            already_uploaded=already_uploaded,
        )
        timings["upload"] = time.monotonic() - started
        progress.report(ProgressUpdate(stage=STAGE_UPLOAD, fraction=1.0))
        _raise_on_transfer_failure(transfer_stats)

    result = PipelineResult(
        video_id=options.video_id,
        attempt_id=options.attempt_id,
        artifacts=artifacts,
        renditions=_rendition_reports(specs, encoded, backend_used),
        enrichments=enrichments,
        playback_policy=options.playback_policy,
        metadata=ProcessingMetadata(
            source_size_bytes=(snapshot.size_bytes if snapshot else source_path.stat().st_size),
            transcoded_size_bytes=sum(artifact.size for artifact in artifacts),
            duration_seconds=metadata.duration,
            width=metadata.width,
            height=metadata.height,
            fps=metadata.fps,
            has_audio=metadata.has_audio,
            has_video=metadata.has_video,
            is_hdr=metadata.is_hdr,
            is_vertical=metadata.is_vertical,
            aspect_ratio=metadata.aspect_ratio,
            timings=timings,
            backend_used=backend_used,
            fallback_reasons=fallbacks,
            plan_fingerprint=options.plan_fingerprint(),
            source_sha256=(snapshot.sha256 if snapshot else ""),
        ),
    )

    progress.report(ProgressUpdate(stage=STAGE_COMPLETE, fraction=1.0))
    if not keep_work_dir:
        # Success is acknowledged by the caller; the work directory is its to
        # remove. Keeping the removal here would delete evidence on the
        # Modal path, where the container is torn down anyway.
        pass

    return result


# ── helpers ──────────────────────────────────────────────────────────────────

def _assert_hdr_supported(metadata: VideoMetadata) -> None:
    """
    Reject HDR variants with no validated conversion path.

    The plan is explicit that a visibly incorrect picture is worse than a typed
    failure. `zscale`+`tonemap` handles PQ (HDR10) and HLG, which is what the
    format probe recognises; anything else reaching here means the recognised
    transfer function has no tested mapping.
    """
    from openvod_transcoder.encoding.backends import SUPPORTED_HDR_TRANSFERS

    transfer = (metadata.color_transfer or "").lower()
    if transfer and transfer not in SUPPORTED_HDR_TRANSFERS:
        raise TranscodeError(
            ERROR_UNSUPPORTED_HDR,
            f"HDR transfer characteristic '{transfer}' has no validated SDR "
            f"conversion. Re-export as SDR (BT.709) or as HDR10/HLG.",
        )


def _probe_streams(source_path: Path) -> List[dict]:
    """
    Read the stream table. Separate from `get_video_metadata` because audio track
    *selection* needs the disposition flags, which the video summary drops.
    """
    import json

    try:
        probe = run_cmd(
            [
                "ffprobe", "-v", "error",
                "-show_streams", "-of", "json", str(source_path),
            ],
            label="ffprobe-streams",
            check=False,
        )
        if probe.returncode != 0:
            return []
        return json.loads(probe.stdout or "{}").get("streams") or []
    except Exception as exc:  # noqa: BLE001 — audio selection is best effort
        print(f"[PIPELINE] stream probe failed: {exc}")
        return []


def _encode_all(
    *,
    source_path: Path,
    fmp4_dir: Path,
    output_dir: Path,
    specs: Sequence[RenderSpec],
    metadata: VideoMetadata,
    options: ProcessingOptions,
    report: CapabilityReport,
    audio_plan,
    progress: ProgressSink,
    token: CancellationToken,
    ffmpeg: str,
    reusable: Optional[Dict[str, str]] = None,
    on_rendition: Optional[Callable[[str, Path], None]] = None,
) -> tuple[Dict[str, Path], Optional[Path], str, List[str]]:
    """
    Encode every rendition and the audio track under one bounded thread pool.

    Concurrency is bounded by the *operator's* setting, not by a heuristic tuned
    for one GPU model. A self-hosted machine is the owner's, and the old
    "3 workers if <4K else 2" rule assumed an L4 with nothing else running.
    """
    chain = select_chain(options.encoder_backend, report, device=options.encoder_device)
    print(f"🎞️ Encoder chain: {describe_chain(chain)}")
    state = FallbackState(chain=chain)

    weights = {spec.label: max(1, spec.height) for spec in specs}
    tracker = RenditionProgress(progress, weights)

    encoded: Dict[str, Path] = {}
    audio_path: Optional[Path] = None
    used_backend = state.current.backend.name

    video_workers = max(1, min(options.rendition_concurrency, max(1, len(specs))))
    audio_workers = 1 if metadata.has_audio else 0

    # Reuse first, and outside the pool: a resumed rendition costs a file copy,
    # not an encode, so it must not occupy a worker slot.
    pending_specs = []
    for spec in specs:
        existing = (reusable or {}).get(spec.label)
        if existing and Path(existing).exists() and Path(existing).stat().st_size > 1000:
            target = fmp4_dir / f"video_{spec.label}.mp4"
            shutil.copyfile(existing, target)
            encoded[spec.label] = target
            tracker.complete(spec.label)
            print(f"♻️ Reusing completed rendition {spec.label} from a previous attempt")
            if on_rendition is not None:
                on_rendition(spec.label, target)
            continue
        pending_specs.append(spec)

    with ThreadPoolExecutor(max_workers=max(video_workers, audio_workers, 1)) as pool:
        futures = {}
        if metadata.has_audio:
            futures[pool.submit(
                _encode_audio,
                source_path=source_path,
                output_path=fmp4_dir / "audio.mp4",
                audio_stream=(getattr(audio_plan, "stream_index", None) if audio_plan else None),
                token=token,
                ffmpeg=ffmpeg,
            )] = ("audio", None)

        for spec in pending_specs:
            futures[pool.submit(
                _encode_rendition_with_fallback,
                source_path=source_path,
                output_path=fmp4_dir / f"video_{spec.label}.mp4",
                spec=spec,
                metadata=metadata,
                options=options,
                report=report,
                state=state,
                tracker=tracker,
                token=token,
                ffmpeg=ffmpeg,
            )] = ("video", spec)

        for future in as_completed(futures):
            kind, spec = futures[future]
            token.raise_if_cancelled()
            if kind == "audio":
                audio_path = future.result()
                tracker.complete("audio")
                continue
            try:
                encoded[spec.label] = future.result()
                tracker.complete(spec.label)
                used_backend = state.current.backend.name
                print(f"✅ Completed: {spec.label} ({spec.resolution})")
                # Recorded now, not after upload: a job that fails during
                # transfer must be resumable without re-encoding, and the whole
                # value of the journal is that it holds work already done.
                if on_rendition is not None:
                    on_rendition(spec.label, encoded[spec.label])
            except CancelledError:
                raise
            except Exception as exc:
                tracker.failed(spec.label)
                print(f"❌ Failed {spec.label}: {exc}")
                # A required rendition failing is a job failure. Partial ladders
                # are worse than none: the master playlist would advertise
                # rungs that are not there.
                raise

    if not encoded and not audio_path:
        raise TranscodeError(
            ERROR_MISSING_RENDITION, "no rendition and no audio track were produced"
        )

    _ = output_dir
    return encoded, audio_path, used_backend, list(state.fallback_reasons)


def _encode_rendition_with_fallback(
    *,
    source_path: Path,
    output_path: Path,
    spec: RenderSpec,
    metadata: VideoMetadata,
    options: ProcessingOptions,
    report: CapabilityReport,
    state: FallbackState,
    tracker: RenditionProgress,
    token: CancellationToken,
    ffmpeg: str,
) -> Path:
    """
    Encode one rendition, walking the fallback chain on encoder-path failures.

    The chain is advanced *inside* the rendition rather than by restarting the
    job, so an already-finished 720p rendition is not thrown away because the
    1080p one hit a GPU limit.
    """
    while True:
        candidate = state.current
        token.raise_if_cancelled()
        try:
            return _encode_rendition(
                source_path=source_path,
                output_path=output_path,
                spec=spec,
                metadata=metadata,
                options=options,
                candidate=candidate,
                tracker=tracker,
                token=token,
                ffmpeg=ffmpeg,
            )
        except CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — the policy decides what to do
            next_candidate = state.advance(exc)
            if next_candidate is None:
                if state.fallback_reasons:
                    raise TranscodeError(
                        ERROR_ENCODER_FAILED,
                        f"{spec.label} failed on every encoder "
                        f"({'; '.join(state.fallback_reasons)}); last error: {exc}",
                    ) from exc
                raise
            print(
                f"↩️ {spec.label}: {candidate.label} failed, retrying with "
                f"{next_candidate.label} — {exc}"
            )
            # A failed partial file must not be mistaken for a finished one.
            try:
                Path(output_path).unlink()
            except OSError:
                pass
    _ = report


def _encode_rendition(
    *,
    source_path: Path,
    output_path: Path,
    spec: RenderSpec,
    metadata: VideoMetadata,
    options: ProcessingOptions,
    candidate: BackendCandidate,
    tracker: RenditionProgress,
    token: CancellationToken,
    ffmpeg: str,
) -> Path:
    backend: EncoderBackend = candidate.backend
    cmd = build_video_command(
        ffmpeg=ffmpeg,
        input_path=str(source_path),
        output_path=str(output_path),
        backend=backend,
        spec=spec,
        metadata=metadata,
        segment_duration=options.segment_duration or 4.0,
        gpu_decode=candidate.gpu_decode,
    )
    if options.ffmpeg_threads > 0:
        cmd = cmd[:2] + ["-threads", str(options.ffmpeg_threads)] + cmd[2:]

    run_ffmpeg(
        cmd,
        label=f"encode-{spec.label}-{candidate.label}",
        duration=metadata.duration,
        on_progress=lambda decoded, fraction: tracker.update(spec.label, fraction, decoded.speed),
        cancellation=token,
        stall=StallPolicy(timeout_seconds=options.stall_timeout_seconds),
    )

    if not output_path.exists():
        raise TranscodeError(
            ERROR_ENCODER_FAILED, f"{backend.name} produced no output for {spec.label}"
        )
    size = output_path.stat().st_size
    if size < 1000:
        raise TranscodeError(
            ERROR_ENCODER_FAILED,
            f"{backend.name} output for {spec.label} is {size} bytes — encoding failed",
        )
    return output_path


def _encode_audio(
    *,
    source_path: Path,
    output_path: Path,
    audio_stream: Optional[int],
    token: CancellationToken,
    ffmpeg: str,
) -> Path:
    run_ffmpeg(
        build_audio_command(
            ffmpeg=ffmpeg,
            input_path=str(source_path),
            output_path=str(output_path),
            audio_stream=audio_stream,
        ),
        label="encode-audio",
        on_progress=None,
        cancellation=token,
        stall=StallPolicy(timeout_seconds=900.0),
    )
    if not output_path.exists() or output_path.stat().st_size < 1000:
        raise TranscodeError(ERROR_MISSING_RENDITION, f"audio output invalid: {output_path}")
    return output_path


def _run_transcription(
    source_path: Path,
    output_dir: Path,
    metadata: VideoMetadata,
    options: ProcessingOptions,
    *,
    token: CancellationToken,
) -> EnrichmentStatus:
    """Transcribe, tolerating failure: subtitles are enrichment, not the video."""
    status = EnrichmentStatus(name="subtitles", requested=options.generate_subtitle)
    if not options.generate_subtitle:
        return status
    if not metadata.has_audio:
        status.status = "skipped"
        return status
    try:
        from openvod_transcoder.video.transcription import transcribe_to_vtt

        token.raise_if_cancelled()
        transcribe_to_vtt(
            source_path,
            output_dir / "subtitles.vtt",
            model_size=options.whisper_model,
            language=options.transcribe_language,
        )
        status.generated = True
        status.status = "completed"
        status.url = "subtitles.vtt"
    except CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — explicitly nonfatal
        status.status = "failed"
        status.error = str(exc)
        print(f"⚠️ AI transcription failed (nonfatal): {exc}")
    return status


def _run_chapters(
    output_dir: Path,
    metadata: VideoMetadata,
    options: ProcessingOptions,
    subtitle: EnrichmentStatus,
) -> EnrichmentStatus:
    """Chapter generation from the transcript. Nonfatal, and requires subtitles."""
    status = EnrichmentStatus(name="chapters", requested=options.generate_chapters)
    if not options.generate_chapters:
        return status
    if not subtitle.generated:
        status.status = "skipped"
        return status
    try:
        import json

        from openvod_transcoder.video.chapters import generate_chapters

        with open(output_dir / subtitle.url, "r", encoding="utf-8") as handle:
            vtt_content = handle.read()
        chapters = generate_chapters(vtt_content=vtt_content, duration_seconds=metadata.duration)
        with open(output_dir / "chapters.json", "w", encoding="utf-8") as handle:
            json.dump(chapters, handle, indent=2)
        status.generated = True
        status.status = "completed"
        status.data = chapters
        status.url = "chapters.json"
    except Exception as exc:  # noqa: BLE001 — explicitly nonfatal
        status.status = "failed"
        status.error = str(exc)
        print(f"⚠️ AI chapters generation failed (nonfatal): {exc}")
    return status


def _validate_package(
    artifacts: Sequence[Artifact],
    specs: Sequence[RenderSpec],
    has_audio: bool,
) -> None:
    """
    Check the package is complete before anything is uploaded.

    Two assertions that catch the failures that matter. A missing master playlist
    means the package is unusable; a missing `init.mp4` for a rendition means the
    player will fail at *switch* time, long after the job was marked ready, with
    an error nobody can trace back to the encode.
    """
    paths = {artifact.path for artifact in artifacts}
    if "playlist.m3u8" not in paths:
        raise TranscodeError(
            ERROR_PACKAGING_FAILED, "packaging produced no playlist.m3u8 master manifest"
        )

    for spec in specs:
        prefix = f"video_{spec.label}/"
        if not any(path.startswith(prefix) for path in paths):
            raise TranscodeError(
                ERROR_MISSING_RENDITION,
                f"rendition {spec.label} is missing from the packaged output",
            )
        if f"{prefix}init.mp4" not in paths:
            raise TranscodeError(
                ERROR_MISSING_RENDITION,
                f"rendition {spec.label} has no init segment — players will fail on switch",
            )

    if has_audio and not any(path.startswith("audio/") for path in paths):
        raise TranscodeError(
            ERROR_MISSING_RENDITION, "audio track was encoded but is missing from the package"
        )


def _raise_on_transfer_failure(stats: TransferStats) -> None:
    from openvod_transcoder.errors import ERROR_PARTIAL_UPLOAD

    if stats.complete:
        return
    preview = ", ".join(stats.failed_paths()[:10])
    raise TranscodeError(
        ERROR_PARTIAL_UPLOAD,
        f"transferred {stats.uploaded}/{stats.total} artifacts "
        f"(failed: {preview or 'unknown'})",
    )


def _rendition_reports(
    specs: Sequence[RenderSpec],
    encoded: Dict[str, Path],
    backend_used: str,
) -> List[RenditionReport]:
    reports = []
    for spec in specs:
        path = encoded.get(spec.label)
        reports.append(
            RenditionReport(
                label=spec.label,
                width=spec.width,
                height=spec.height,
                bitrate=spec.bitrate,
                backend=backend_used,
                bytes=(path.stat().st_size if path and path.exists() else 0),
            )
        )
    return reports


def output_prefix(video_id: str, attempt_id: str, prefix: str = R2_PREFIX) -> str:
    """
    Attempt-scoped output prefix.

    Every self-hosted attempt writes here rather than to ``videos/<video-id>/``.
    Without the attempt segment a late worker from a superseded attempt overwrites
    the newer attempt's segments *after* the newer attempt published — the
    application's playback reference would point at a mix of two encodes.
    """
    return f"{prefix.strip('/')}/{video_id}/attempts/{attempt_id}"


def package_exports(metadata: "VideoMetadata") -> dict:
    """Small helper for the CLI's `--json` output."""
    return parse_ffprobe_passthrough(metadata)


def parse_ffprobe_passthrough(metadata: VideoMetadata) -> dict:
    return {
        "width": metadata.width,
        "height": metadata.height,
        "duration": metadata.duration,
        "fps": metadata.fps,
        "hasAudio": metadata.has_audio,
        "hasVideo": metadata.has_video,
        "isHdr": metadata.is_hdr,
        "isVertical": metadata.is_vertical,
    }


# Re-exported so callers can probe once and reuse the report without importing
# the encoding package directly.
__all__ = [
    "NON_FALLBACK_CODES",
    "detect_capabilities",
    "output_prefix",
    "package_exports",
    "parse_ffprobe",
    "run_pipeline",
]
