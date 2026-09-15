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
- **Encoding** — chosen through :mod:`clipmux_transcoder.encoding` from a
  capability report, not from an environment variable read deep in a helper.
- **Transfer** — the caller supplies a transfer; the engine never reads storage
  credentials. This is what makes "the agent holds no R2 keys" structural
  rather than a promise.

The module imports without Modal, CUDA, boto3 or Whisper: optional dependencies
load inside the code path that needs them, so `import clipmux_transcoder` works
on a bare machine.
"""
from __future__ import annotations

import shutil
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence

from clipmux_transcoder.cancellation import CancellationToken
from clipmux_transcoder.config import R2_PREFIX
from clipmux_transcoder.encoding.backends import (
    EncoderBackend,
    RenderSpec,
    build_audio_command,
    build_video_command,
    source_gpu_path_supported,
)
from clipmux_transcoder.encoding.failures import FAILURE_SESSION, marks_backend_unusable
from clipmux_transcoder.encoding.probe import (
    CapabilityReport,
    ChainProbe,
    detect_capabilities,
    preflight_source,
    toolchain_identity,
    toolchain_versions,
)
from clipmux_transcoder.encoding.selection import (
    BackendCandidate,
    FallbackState,
    WorkerEncoderState,
    build_attempt_chain,
    describe_chain,
    select_chain,
)
from clipmux_transcoder.encoding.validation import (
    validate_encoded_rendition,
    validate_manifest_references,
)
from clipmux_transcoder.errors import (
    ERROR_AUDIO_ONLY_UNSUPPORTED,
    ERROR_EMPTY_FILE,
    ERROR_MISSING_RENDITION,
    ERROR_PACKAGING_FAILED,
    ERROR_UNSUPPORTED_HDR,
    ERROR_ENCODER_FAILED,
    CancelledError,
    TranscodeError,
    is_fallback_eligible,
)
from clipmux_transcoder.ffmpeg_progress import StallPolicy, run_ffmpeg
from clipmux_transcoder.options import ProcessingOptions
from clipmux_transcoder.packaging import choose_segment_duration, package_with_shaka
from clipmux_transcoder.planning import plan_audio, plan_renditions
from clipmux_transcoder.progress import (
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
from clipmux_transcoder.result import (
    Artifact,
    EnrichmentStatus,
    PipelineResult,
    ProcessingMetadata,
    RenditionReport,
    build_inventory,
)
from clipmux_transcoder.snapshot import SourceSnapshot
from clipmux_transcoder.transfer import ArtifactTransfer, TransferStats
from clipmux_transcoder.utils.cmd import run_cmd
from clipmux_transcoder.video.analysis import VideoMetadata, get_video_metadata, parse_ffprobe

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
            from clipmux_transcoder.video.poster import generate_poster

            generate_poster(str(source_path), str(output_dir / "poster.jpg"), metadata.duration)
            poster_generated = True
        except CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a missing poster is not a failed job
            print(f"[PIPELINE] poster generation failed (nonfatal): {exc}")

    # ── encode ───────────────────────────────────────────────────────────────
    #
    # The segment duration is resolved *once*, here, and then used for both the
    # encoder's keyframe interval and Shaka's --segment_duration. Resolving it
    # twice is how a short clip ends up with a GOP that disagrees with its
    # segments: every boundary lands between two keyframes and playback stalls.
    segment_duration = options.segment_duration or choose_segment_duration(metadata.duration)

    started = time.monotonic()
    outcome = _encode_all(
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
        segment_duration=segment_duration,
        reusable=reusable_renditions,
        on_rendition=on_rendition,
    )
    timings["transcode"] = time.monotonic() - started
    encoded = {label: entry.path for label, entry in outcome.renditions.items()}
    audio_path = outcome.audio_path
    backend_used = outcome.backend_used
    fallbacks = outcome.fallback_reasons

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
    _validate_package(output_dir, artifacts, specs, audio_path is not None)

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
        renditions=_rendition_reports(specs, outcome.renditions),
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
            plan_fingerprint=options.plan_fingerprint(
                toolchain=toolchain_identity_of(report)
            ),
            source_sha256=(snapshot.sha256 if snapshot else ""),
            toolchain=toolchain_versions(report),
            rendition_executions=[
                entry.as_payload() for entry in _rendition_reports(specs, outcome.renditions)
            ],
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
    from clipmux_transcoder.encoding.backends import SUPPORTED_HDR_TRANSFERS

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


@dataclass
class EncodedRendition:
    """One finished rendition, and how it was actually produced."""
    path: Path
    backend: str
    mode: str
    attempts: int = 1
    seconds: float = 0.0
    fallback_reasons: List[str] = field(default_factory=list)


@dataclass
class EncodeOutcome:
    """Everything the encode stage produced, including why it chose what it did."""
    renditions: Dict[str, EncodedRendition] = field(default_factory=dict)
    audio_path: Optional[Path] = None
    backend_used: str = ""
    fallback_reasons: List[str] = field(default_factory=list)


def encode_threads_for(mode: str, options: ProcessingOptions) -> int:
    """
    Thread bound for one execution path. Pure, and checked with literals.

    The three paths have genuinely different needs: a full-GPU encode needs
    almost no CPU, a hybrid encode does all its decoding and scaling in software,
    and a CPU encode is the whole job. Bounding them with one number is how a
    GPU job starves itself of the threads that feed the encoder.
    """
    if mode == "cpu":
        return options.cpu_ffmpeg_threads or options.ffmpeg_threads
    if mode == "hybrid":
        return options.hybrid_ffmpeg_threads or options.ffmpeg_threads
    return options.ffmpeg_threads


def video_worker_count(
    candidates: Sequence[BackendCandidate],
    options: ProcessingOptions,
    spec_count: int,
) -> int:
    """
    How many renditions to encode at once.

    The operator's setting is the ceiling. The only extra rule is the CPU: a
    CPU-only job that runs N x264 encodes in parallel finishes later than the
    same job run one at a time, because N encoders contend for the same cores —
    so an operator who configured a separate CPU bound gets it.
    """
    workers = max(1, min(options.rendition_concurrency, max(1, spec_count)))
    if options.cpu_rendition_concurrency > 0 and not any(
        candidate.backend.is_hardware for candidate in candidates
    ):
        workers = min(workers, max(1, options.cpu_rendition_concurrency))
    return workers


def run_preflight(
    *,
    source_path: Path,
    metadata: VideoMetadata,
    chain: Sequence[BackendCandidate],
    specs: Sequence[RenderSpec],
    ffmpeg: str,
    token: CancellationToken,
) -> Dict[str, ChainProbe]:
    """
    Verify each hardware backend against the real source, once, before encoding.

    Run at the *largest planned rendition's* dimensions and bounded to a short
    sample, so it exercises the scaler at a size the job will really use without
    costing an encode. A preflight that raises unexpectedly is recorded as
    "unverified" rather than propagating: an unverified GPU must exclude itself
    under `auto`, not fail the job.
    """
    if not specs:
        return {}

    spec = max(specs, key=lambda entry: (entry.height, entry.width))
    probes: Dict[str, ChainProbe] = {}
    for candidate in chain:
        backend = candidate.backend
        if not backend.is_hardware or backend.name in probes:
            continue
        token.raise_if_cancelled()
        try:
            probe = preflight_source(
                source_path, metadata, backend, spec=spec, ffmpeg=ffmpeg
            )
        except CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — an unverified backend is not a failed job
            probe = ChainProbe(backend=backend.name, reason=f"preflight errored: {exc}")
        probes[backend.name] = probe
        print(f"🔎 Preflight {backend.name}: {probe.reason}")
    return probes


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
    segment_duration: float,
    reusable: Optional[Dict[str, str]] = None,
    on_rendition: Optional[Callable[[str, Path], None]] = None,
) -> EncodeOutcome:
    """
    Encode every rendition and the audio track under one bounded thread pool.

    Concurrency is bounded by the *operator's* setting, not by a heuristic tuned
    for one GPU model. A self-hosted machine is the owner's, and the old
    "3 workers if <4K else 2" rule assumed an L4 with nothing else running.

    Each rendition gets its own attempt state; the *machine* knowledge ("this
    encoder cannot open its device") is shared, because re-discovering it per
    rendition is pure waste. A terminal failure stops the siblings instead of
    waiting for them.
    """
    chain = select_chain(options.encoder_backend, report, device=options.encoder_device)
    print(f"🎞️ Encoder chain: {describe_chain(chain)}")

    requested = (options.encoder_backend or "auto").strip().lower()
    require_verification = requested in ("", "auto")

    probes: Dict[str, ChainProbe] = {}
    if specs and metadata.has_video:
        probes = run_preflight(
            source_path=source_path,
            metadata=metadata,
            chain=chain,
            specs=specs,
            ffmpeg=ffmpeg,
            token=token,
        )

    candidates = build_attempt_chain(
        chain,
        gpu_path_supported=source_gpu_path_supported(metadata),
        probes=probes,
        require_verification=require_verification,
    )
    print(f"🎯 Verified chain: {describe_chain(candidates)}")

    weights = {spec.label: max(1, spec.height) for spec in specs}
    tracker = RenditionProgress(progress, weights)

    outcome = EncodeOutcome()
    health = WorkerEncoderState(cpu_limit=options.cpu_rendition_concurrency)

    video_workers = video_worker_count(candidates, options, len(specs))
    audio_workers = 1 if metadata.has_audio else 0

    # Reuse first, and outside the pool: a resumed rendition costs a file copy,
    # not an encode, so it must not occupy a worker slot.
    pending_specs = []
    for spec in specs:
        existing = (reusable or {}).get(spec.label)
        if existing and Path(existing).exists() and Path(existing).stat().st_size > 1000:
            target = fmp4_dir / f"video_{spec.label}.mp4"
            shutil.copyfile(existing, target)
            outcome.renditions[spec.label] = EncodedRendition(
                path=target, backend="reused", mode="reused"
            )
            tracker.complete(spec.label)
            print(f"♻️ Reusing completed rendition {spec.label} from a previous attempt")
            if on_rendition is not None:
                on_rendition(spec.label, target)
            continue
        pending_specs.append(spec)

    # Siblings are stopped through this token, never by waiting for them.
    stage_token = token.child()
    pool = ThreadPoolExecutor(max_workers=max(video_workers, audio_workers, 1))
    futures = {}
    if metadata.has_audio:
        futures[pool.submit(
            _encode_audio,
            source_path=source_path,
            output_path=fmp4_dir / "audio.mp4",
            audio_stream=(getattr(audio_plan, "stream_index", None) if audio_plan else None),
            token=stage_token,
            ffmpeg=ffmpeg,
            threads=options.audio_ffmpeg_threads,
        )] = ("audio", None)

    for spec in pending_specs:
        futures[pool.submit(
            _encode_rendition_with_fallback,
            source_path=source_path,
            output_path=fmp4_dir / f"video_{spec.label}.mp4",
            spec=spec,
            metadata=metadata,
            options=options,
            candidates=candidates,
            health=health,
            tracker=tracker,
            token=stage_token,
            ffmpeg=ffmpeg,
            segment_duration=segment_duration,
        )] = ("video", spec)

    try:
        for future in as_completed(futures):
            kind, spec = futures[future]
            token.raise_if_cancelled()
            if kind == "audio":
                outcome.audio_path = future.result()
                tracker.complete("audio")
                continue
            try:
                encoded = future.result()
            except CancelledError:
                raise
            except Exception as exc:
                tracker.failed(spec.label)
                print(f"❌ Failed {spec.label}: {exc}")
                # A required rendition failing is a job failure. Partial ladders
                # are worse than none: the master playlist would advertise
                # rungs that are not there.
                raise
            outcome.renditions[spec.label] = encoded
            outcome.fallback_reasons.extend(encoded.fallback_reasons)
            tracker.complete(spec.label)
            print(
                f"✅ Completed: {spec.label} ({spec.resolution}) on "
                f"{encoded.backend}/{encoded.mode}"
            )
            # Recorded now, not after upload: a job that fails during transfer
            # must be resumable without re-encoding, and the whole value of the
            # journal is that it holds work already done.
            if on_rendition is not None:
                on_rendition(spec.label, encoded.path)
    except BaseException:
        # Stop siblings, then reap them before the caller cleans the work tree
        # or starts another attempt using the same device and filenames.
        stage_token.cancel("a required rendition failed")
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    else:
        pool.shutdown(wait=True)

    if not outcome.renditions and outcome.audio_path is None:
        raise TranscodeError(
            ERROR_MISSING_RENDITION, "no rendition and no audio track were produced"
        )

    backends = {entry.backend for entry in outcome.renditions.values()}
    backends.discard("reused")
    if len(backends) == 1:
        outcome.backend_used = next(iter(backends))
    elif backends:
        # A ladder completed across two encoders is not "cpu" or "nvenc": the
        # operator needs to know the job was split, and why.
        outcome.backend_used = "mixed"
    else:
        outcome.backend_used = "cpu"  # audio-only jobs encode in software

    return outcome


def _remove_incomplete(path: Path) -> None:
    """Delete a failed attempt's partial output; never mistake it for a good one."""
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:  # noqa: BLE001 — a stale file is not worth failing over
        print(f"[PIPELINE] could not remove partial output {path}: {exc}")


def _chain_exhausted(
    spec: RenderSpec, state: FallbackState, exc: Optional[BaseException]
) -> TranscodeError:
    if isinstance(exc, TranscodeError) and not is_fallback_eligible(exc):
        return exc
    if state.fallback_reasons:
        return TranscodeError(
            ERROR_ENCODER_FAILED,
            f"{spec.label} failed on every encoder path "
            f"({'; '.join(state.fallback_reasons)}); last error: {exc}",
        )
    if isinstance(exc, TranscodeError):
        return exc
    return TranscodeError(
        ERROR_ENCODER_FAILED, f"{spec.label}: no encoder path was available"
    )


def _encode_rendition_with_fallback(
    *,
    source_path: Path,
    output_path: Path,
    spec: RenderSpec,
    metadata: VideoMetadata,
    options: ProcessingOptions,
    candidates: Sequence[BackendCandidate],
    health: WorkerEncoderState,
    tracker: RenditionProgress,
    token: CancellationToken,
    ffmpeg: str,
    segment_duration: float,
) -> EncodedRendition:
    """
    Encode one rendition, walking *its own* fallback chain on encoder failures.

    The chain is per rendition, so a GPU limit hit by the 1080p rung does not
    advance the 720p rung onto a backend it never tried — the defect that made a
    job report a backend that produced none of its bytes.

    The failure policy, in order:

    - cancellation always propagates;
    - a transient GPU session exhaustion is serialized against the other
      renditions and retried **once** on the same candidate;
    - a failure that proves the backend unusable (no device, no encoder) is
      recorded on the shared state so *other* renditions skip it too;
    - anything else eligible advances to the next candidate, deleting the
      incomplete output first;
    - ineligible failures (bad media, full disk, missing input) raise as they are.
    """
    state = FallbackState(chain=candidates)
    started = time.monotonic()

    def _finish(path: Path, candidate: BackendCandidate) -> EncodedRendition:
        return EncodedRendition(
            path=path,
            backend=candidate.backend.name,
            mode=candidate.mode,
            attempts=sum(state.attempt_counts.values()),
            seconds=time.monotonic() - started,
            fallback_reasons=list(state.fallback_reasons),
        )

    def _attempt(candidate: BackendCandidate, *, serialize: bool = False) -> Path:
        slot = (health.cpu_slot(token) if candidate.mode == "cpu"
                else health.gpu_slot(token, serialize=serialize))
        with slot:
            token.raise_if_cancelled()
            return _run_attempt(candidate)

    def _run_attempt(candidate: BackendCandidate) -> Path:
        state.record_attempt()
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
            segment_duration=segment_duration,
        )

    while True:
        candidate = state.current

        if health.is_unusable(candidate.backend.name):
            reason = health.reason(candidate.backend.name)
            print(
                f"⏭️ {spec.label}: skipping {candidate.label} — "
                f"{candidate.backend.name} is unusable here ({reason})"
            )
            if state.skip(f"{candidate.backend.name} unusable: {reason}") is None:
                raise _chain_exhausted(spec, state, None)
            continue

        token.raise_if_cancelled()
        attempt_number = state.attempts_for(candidate.label)

        try:
            return _finish(_attempt(candidate), candidate)
        except CancelledError:
            raise
        except TranscodeError as exc:
            failure_kind = getattr(exc, "failure_kind", "")

            if failure_kind == FAILURE_SESSION and attempt_number == 0:
                # Verified session exhaustion: serialize the GPU work and retry
                # the same backend once. Falling back to the CPU here would
                # throw away the GPU over a condition that clears by itself.
                token.raise_if_cancelled()
                print(
                    f"🔒 {spec.label}: {candidate.label} hit a GPU session limit; "
                    f"retrying once, serialized"
                )
                _remove_incomplete(output_path)
                try:
                    return _finish(_attempt(candidate, serialize=True), candidate)
                except CancelledError:
                    raise
                except TranscodeError as retry_exc:
                    exc = retry_exc
                    failure_kind = getattr(retry_exc, "failure_kind", "")

            if marks_backend_unusable(failure_kind):
                health.mark_unusable(candidate.backend.name, str(exc))

            next_candidate = state.advance(exc)
            if next_candidate is None:
                raise _chain_exhausted(spec, state, exc) from exc

            print(
                f"↩️ {spec.label}: {candidate.label} failed, retrying with "
                f"{next_candidate.label} — {exc}"
            )
            _remove_incomplete(output_path)


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
    segment_duration: float,
) -> Path:
    backend: EncoderBackend = candidate.backend
    cmd = build_video_command(
        ffmpeg=ffmpeg,
        input_path=str(source_path),
        output_path=str(output_path),
        backend=backend,
        spec=spec,
        metadata=metadata,
        segment_duration=segment_duration,
        gpu_decode=candidate.gpu_decode,
    )
    threads = encode_threads_for(candidate.mode, options)
    if threads > 0:
        cmd = cmd[:2] + ["-threads", str(threads), "-filter_threads", str(threads)] + cmd[2:]
        cmd = cmd[:-1] + ["-threads:v", str(threads)] + cmd[-1:]

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

    # The encoder's exit status is not evidence that the bytes are what we asked
    # for; this is. It runs before packaging so a wrong rendition is retried
    # instead of being published.
    validate_encoded_rendition(
        output_path, spec, duration=metadata.duration, ffmpeg=ffmpeg
    )
    return output_path


def _encode_audio(
    *,
    source_path: Path,
    output_path: Path,
    audio_stream: Optional[int],
    token: CancellationToken,
    ffmpeg: str,
    threads: int = 0,
) -> Path:
    cmd = build_audio_command(
        ffmpeg=ffmpeg,
        input_path=str(source_path),
        output_path=str(output_path),
        audio_stream=audio_stream,
    )
    if threads > 0:
        cmd = cmd[:2] + ["-threads", str(threads), "-filter_threads", str(threads)] + cmd[2:]
        cmd = cmd[:-1] + ["-threads:a", str(threads)] + cmd[-1:]
    run_ffmpeg(
        cmd,
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
        from clipmux_transcoder.video.transcription import transcribe_to_vtt

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

        from clipmux_transcoder.video.chapters import generate_chapters

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
    output_dir: Path,
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

    # A manifest that points at files nobody uploaded is a package that plays
    # until the first switch or the first segment, then fails in the player.
    validate_manifest_references(output_dir, artifacts)


def _raise_on_transfer_failure(stats: TransferStats) -> None:
    from clipmux_transcoder.errors import ERROR_PARTIAL_UPLOAD

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
    encoded: Dict[str, EncodedRendition],
) -> List[RenditionReport]:
    """
    Per-rendition execution details, from what actually produced each one.

    The backend is the rendition's own, not the job's: reporting one backend for
    the whole ladder is how a job claimed to have encoded on NVENC while three of
    its four renditions were produced on the CPU.
    """
    reports = []
    for spec in specs:
        entry = encoded.get(spec.label)
        path = entry.path if entry else None
        reports.append(
            RenditionReport(
                label=spec.label,
                width=spec.width,
                height=spec.height,
                bitrate=spec.bitrate,
                backend=entry.backend if entry else "",
                mode=entry.mode if entry else "",
                attempts=entry.attempts if entry else 0,
                seconds=round(entry.seconds, 2) if entry else 0.0,
                bytes=(path.stat().st_size if path and path.exists() else 0),
            )
        )
    return reports


def toolchain_identity_of(report: CapabilityReport) -> str:
    """Compact toolchain identity for reuse fingerprints (see options)."""
    return toolchain_identity(report)


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
    "EncodeOutcome",
    "EncodedRendition",
    "NON_FALLBACK_CODES",
    "detect_capabilities",
    "encode_threads_for",
    "output_prefix",
    "package_exports",
    "parse_ffprobe",
    "run_pipeline",
]
