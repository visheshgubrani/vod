"""
Generate completion-payload fixtures from the **real** engine.

The two halves of this system are written in different languages, and the seam
between them is a JSON payload that neither compiler checks. That is exactly
where the Modal playback-URL regression lived: the engine began returning
output-relative paths, the TypeScript finalizer kept assuming complete object
keys, and every new Modal video got a URL that 404s — with no test able to see
both sides at once.

So the Python engine writes what it actually produces, and the TypeScript suite
asserts what the API makes of it. The fixtures are committed, and
`test_contract_fixtures` regenerates them and fails if they drift, so the pair
cannot silently disagree again.

Run directly to refresh:

    python -m tests.contract_fixtures
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from clipmux_transcoder.result import Artifact, EnrichmentStatus, PipelineResult, ProcessingMetadata, RenditionReport

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"

VIDEO_ID = "3f1c2b4a-0000-4000-8000-000000000001"
ATTEMPT_ID = "att-contract-1"
R2_PREFIX = "videos"


def _artifacts() -> List[Artifact]:
    return [
        Artifact(path="audio/1.m4s", size=4096, checksum="a" * 64, role="segment"),
        Artifact(path="audio/init.mp4", size=1024, checksum="b" * 64, role="segment"),
        Artifact(path="manifest.mpd", size=2048, checksum="c" * 64, role="dash"),
        Artifact(path="playlist.m3u8", size=512, checksum="d" * 64, role="playlist"),
        Artifact(path="poster.jpg", size=8192, checksum="e" * 64, role="poster"),
        Artifact(path="subtitles.vtt", size=256, checksum="f" * 64, role="subtitle"),
        Artifact(path="video_1080p/1.m4s", size=65536, checksum="0" * 64, role="segment"),
        Artifact(path="video_1080p/init.mp4", size=1024, checksum="1" * 64, role="segment"),
    ]


def build_result(*, mixed: bool = False) -> PipelineResult:
    """
    A result with every optional output present, so nothing is untested.

    ``mixed=True`` produces the *split-ladder* case: one rung finished on the GPU
    and another on the CPU, so the job-level backend is ``mixed`` and the
    per-rendition execution details are the only place that says which was which.
    """
    renditions = [
        RenditionReport(
            label="1080p", width=1920, height=1080, bitrate="5M",
            backend="nvenc" if mixed else "cpu",
            mode="hybrid" if mixed else "cpu",
            attempts=2 if mixed else 1,
            seconds=41.5 if mixed else 90.2,
            files=2, bytes=66560,
        ),
    ]
    if mixed:
        renditions.append(
            RenditionReport(
                label="720p", width=1280, height=720, bitrate="3M",
                backend="cpu", mode="cpu", attempts=1, seconds=22.75,
                files=2, bytes=30720,
            )
        )
    return PipelineResult(
        video_id=VIDEO_ID,
        attempt_id=ATTEMPT_ID,
        artifacts=_artifacts(),
        renditions=renditions,
        enrichments={
            "subtitles": EnrichmentStatus(
                name="subtitles", requested=True, generated=True,
                status="completed", url="subtitles.vtt",
            ),
            "chapters": EnrichmentStatus(
                name="chapters", requested=True, generated=True, status="completed",
                url="chapters.json",
                data=[{"startTime": 0, "endTime": 12, "title": "Introduction"}],
            ),
        },
        metadata=ProcessingMetadata(
            source_size_bytes=1048576,
            transcoded_size_bytes=82432,
            duration_seconds=61.4,
            width=1920,
            height=1080,
            fps=30.0,
            has_audio=True,
            has_video=True,
            is_hdr=False,
            is_vertical=False,
            aspect_ratio="1.78:1",
            timings={"analyze": 0.4, "transcode": 90.2, "package": 3.1, "upload": 6.0},
            backend_used="mixed" if mixed else "cpu",
            fallback_reasons=(
                ["1080p: nvenc -> nvenc+software-decode: FFmpegProcessError: filter"]
                if mixed
                else []
            ),
            plan_fingerprint="fingerprint-contract",
            source_sha256="deadbeef",
            # Additive diagnostics: which toolchain produced the bytes, and how
            # each rung was actually encoded.
            toolchain={
                "engine": "1.1.0",
                "planVersion": "2",
                "ffmpeg": "9.0.1",
                "shaka": "3.2.0",
            },
            rendition_executions=[rendition.as_payload() for rendition in renditions],
        ),
        playback_policy="public",
    )


def fixtures() -> Dict[str, Any]:
    """
    Both payload shapes, from one engine result.

    They differ *only* in the key prefix, which is the whole point: the Modal
    callback carries complete object keys because the API handles it with
    rebasing off, and the agent carries output-relative paths because the API
    re-bases them against the recorded attempt prefix.
    """
    result = build_result()
    mixed = build_result(mixed=True)
    return {
        "meta": {
            "videoId": VIDEO_ID,
            "attemptId": ATTEMPT_ID,
            "r2Prefix": R2_PREFIX,
            "note": "Generated by transcoding/tests/contract_fixtures.py — do not edit by hand.",
        },
        "modal": result.as_payload(key_prefix=f"{R2_PREFIX}/{VIDEO_ID}"),
        "agent": result.as_payload(),
        # A ladder completed across two encoders. Additive: an older API that
        # ignores these keys still publishes the video correctly.
        "mixedAgent": mixed.as_payload(),
    }


def write_fixtures() -> Path:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    path = FIXTURE_DIR / "completion_payloads.json"
    path.write_text(json.dumps(fixtures(), indent=2, sort_keys=True) + "\n")
    return path


def main() -> None:
    path = write_fixtures()
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
