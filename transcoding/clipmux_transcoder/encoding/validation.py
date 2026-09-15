"""
Output validation: the encoded rendition and the package that references it.

Two checks that exist because both failures are invisible until a viewer hits
them:

- **The encoded rendition is what was asked for.** A hardware encoder can exit
  zero and still produce the wrong dimensions, an 8-bit-only stream from a 10-bit
  source, or a file that stops early. Nothing downstream would notice: Shaka
  writes a faithful ``RESOLUTION`` attribute for the wrong picture, and the video
  is published.
- **Every URI a manifest references was actually packaged.** A dangling
  ``#EXT-X-STREAM-INF`` or ``<BaseURL>`` plays until the first rendition switch
  or segment, then fails inside the player, minutes after the job reported
  success — the hardest kind of failure to attribute.
"""
from __future__ import annotations

import json
import re
import subprocess
import xml.etree.ElementTree as ET
from urllib.parse import urljoin
from pathlib import Path
from typing import Callable, Iterable, List, Optional, Sequence, Tuple

from openvod_transcoder.encoding.backends import RenderSpec
from openvod_transcoder.errors import (
    ERROR_ENCODER_FAILED,
    ERROR_PACKAGING_FAILED,
    TranscodeError,
)

# H.264 in the High profile, which is what every ladder rung is encoded with.
EXPECTED_CODEC = "h264"
EXPECTED_PIXEL_FORMAT = "yuv420p"

# Duration is allowed to differ from the source by a second or 5%, whichever is
# larger: containers round, and a hardware encoder may drop the final partial
# GOP. Anything beyond that is a truncated encode, not rounding.
DURATION_ABSOLUTE_TOLERANCE = 1.0
DURATION_RELATIVE_TOLERANCE = 0.05

_HLS_URI = re.compile(r'(?:[:,])URI="([^"]+)"')
_DASH_TOKEN = re.compile(r'\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$')


def probe_stream(path: Path, *, ffprobe: str = "ffprobe") -> dict:
    """Read one file's first video stream plus its format block."""
    completed = subprocess.run(
        [
            ffprobe, "-v", "error",
            "-select_streams", "v:0",
            "-show_streams", "-show_format",
            "-of", "json", str(path),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if completed.returncode != 0:
        raise TranscodeError(
            ERROR_ENCODER_FAILED,
            f"ffprobe could not read the encoded rendition {Path(path).name}: "
            f"{(completed.stderr or '').strip()[-300:]}",
        )
    try:
        return json.loads(completed.stdout or "{}")
    except ValueError as exc:
        raise TranscodeError(
            ERROR_ENCODER_FAILED, f"ffprobe returned unreadable JSON for {Path(path).name}: {exc}"
        ) from exc


def validate_encoded_rendition(
    path: Path,
    spec: RenderSpec,
    *,
    duration: Optional[float] = None,
    ffmpeg: str = "ffmpeg",
    probe: Optional[Callable[[Path], dict]] = None,
) -> None:
    """
    Assert an encoded rendition really is the rendition that was planned.

    Raises :class:`TranscodeError` with ``ERROR_ENCODER_FAILED`` — deliberately
    fallback-eligible: an encoder that produced the wrong picture is a reason to
    try the next path, not a reason to fail the job.
    """
    path = Path(path)
    reader = probe or (lambda target: probe_stream(target, ffprobe=_ffprobe_for(ffmpeg)))
    payload = reader(path)

    streams = payload.get("streams") or []
    if not streams:
        raise TranscodeError(
            ERROR_ENCODER_FAILED, f"{path.name}: encoded file has no video stream"
        )
    stream = streams[0]

    codec = str(stream.get("codec_name") or "")
    if codec != EXPECTED_CODEC:
        raise TranscodeError(
            ERROR_ENCODER_FAILED,
            f"{path.name}: expected {EXPECTED_CODEC}, encoder produced {codec or 'nothing'}",
        )

    width, height = int(stream.get("width") or 0), int(stream.get("height") or 0)
    if (width, height) != (spec.width, spec.height):
        raise TranscodeError(
            ERROR_ENCODER_FAILED,
            f"{path.name}: encoded {width}x{height}, planned {spec.width}x{spec.height}",
        )

    pixel_format = str(stream.get("pix_fmt") or "")
    if pixel_format and pixel_format != EXPECTED_PIXEL_FORMAT:
        # `-profile:v high` is 4:2:0 only; anything else either fails in a player
        # or silently changes colour.
        raise TranscodeError(
            ERROR_ENCODER_FAILED,
            f"{path.name}: encoder produced {pixel_format}, expected {EXPECTED_PIXEL_FORMAT}",
        )

    encoded_duration = _duration_of(stream, payload.get("format") or {})
    if duration and encoded_duration:
        tolerance = max(
            DURATION_ABSOLUTE_TOLERANCE, duration * DURATION_RELATIVE_TOLERANCE
        )
        if abs(encoded_duration - duration) > tolerance:
            raise TranscodeError(
                ERROR_ENCODER_FAILED,
                f"{path.name}: encoded {encoded_duration:.2f}s of a {duration:.2f}s "
                f"source — the encode is truncated",
            )


def _duration_of(stream: dict, format_block: dict) -> float:
    for raw in (stream.get("duration"), format_block.get("duration")):
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return 0.0


def _ffprobe_for(ffmpeg: str) -> str:
    """`ffprobe` next to the given `ffmpeg`, so an image's pinned pair is used."""
    path = Path(ffmpeg)
    if path.name != "ffmpeg":
        return "ffprobe"
    return str(path.with_name("ffprobe"))


def manifest_references(output_dir: Path) -> List[Tuple[Path, str]]:
    """
    Every URI a manifest points at, as ``(referencing manifest, uri)``.

    Relative URIs are relative to the *referencing* manifest's directory, which
    is why the manifest itself is returned rather than a bare string: Shaka
    writes a master playlist that points at per-rendition media playlists, and
    those in turn point at ``init.mp4`` beside them.
    """
    output_dir = Path(output_dir)
    references: List[Tuple[Path, str]] = []

    for playlist in sorted(output_dir.rglob("*.m3u8")):
        for line in playlist.read_text(encoding="utf-8", errors="replace").splitlines():
            entry = line.strip()
            references.extend((playlist, uri) for uri in _HLS_URI.findall(entry))
            if not entry or entry.startswith("#"):
                continue
            references.append((playlist, entry))

    for mpd in sorted(output_dir.rglob("*.mpd")):
        references.extend((mpd, uri) for uri in _dash_references(mpd))

    return references


def _dash_references(mpd: Path) -> List[str]:
    """Expand Shaka's static SegmentTimeline, including inherited templates."""
    references: List[str] = []

    def expand(pattern: str, values: dict) -> str:
        def substitute(match):
            value = values[match[1]]
            width = int(match[2] or 0)
            if width > 20:
                raise ValueError("excessive segment number padding")
            return str(value).zfill(width)
        return _DASH_TOKEN.sub(substitute, pattern.replace("$$", "\x00")).replace("\x00", "$")

    def walk(node, base="", attributes=None, timeline=None):
        attributes = dict(attributes or {})
        bases = [child for child in node if child.tag == "BaseURL"]
        if bases:
            base = urljoin(base, (bases[0].text or "").strip())
        template = next((child for child in node if child.tag == "SegmentTemplate"), None)
        if template is not None:
            attributes.update(template.attrib)
            local_timeline = template.find("SegmentTimeline")
            if local_timeline is not None:
                timeline = local_timeline
        if node.tag == "Representation" and attributes:
            values = {"RepresentationID": node.get("id", ""), "Bandwidth": node.get("bandwidth", "")}
            if attributes.get("initialization"):
                references.append(urljoin(base, expand(attributes["initialization"], values)))
            if attributes.get("media"):
                if timeline is None:
                    raise ValueError("media template has no finite SegmentTimeline")
                number, timestamp = int(attributes.get("startNumber", "1")), 0
                for segment in timeline:
                    timestamp = int(segment.get("t", str(timestamp)))
                    duration, repeat = int(segment.get("d", "0")), int(segment.get("r", "0"))
                    if duration <= 0 or repeat < 0 or len(references) + repeat >= 1_000_000:
                        raise ValueError("invalid or unbounded SegmentTimeline")
                    for _ in range(repeat + 1):
                        values.update(Number=number, Time=timestamp)
                        references.append(urljoin(base, expand(attributes["media"], values)))
                        timestamp += duration
                        number += 1
        elif node.tag == "Representation" and base and not base.endswith("/"):
            references.append(base)
        # SegmentList / SegmentBase use concrete references, not templates.
        if node.tag in ("SegmentURL", "Initialization", "RepresentationIndex"):
            for key in ("media", "index", "sourceURL"):
                if node.get(key):
                    references.append(urljoin(base, node.get(key)))
        for child in node:
            if child.tag not in ("SegmentTemplate", "BaseURL"):
                walk(child, base, attributes, timeline)

    try:
        root = ET.parse(mpd).getroot()
        for node in root.iter():
            node.tag = node.tag.rsplit("}", 1)[-1]
        walk(root)
    except (ET.ParseError, ValueError, KeyError) as exc:
        raise TranscodeError(ERROR_PACKAGING_FAILED, f"{mpd.name}: invalid DASH references: {exc}") from exc
    return references


def validate_manifest_references(
    output_dir: Path,
    artifacts: Optional[Iterable] = None,
) -> None:
    """
    Fail when a manifest references something the package does not contain.

    Foreign-host URLs are skipped: the delivery worker rewrites every URI-bearing
    tag and refuses foreign hosts, so they are not this check's business (and
    cannot be verified without the network).
    """
    output_dir = Path(output_dir)
    if artifacts is not None:
        known = {str(getattr(entry, "path", entry)) for entry in artifacts}
    else:
        known = {
            file.relative_to(output_dir).as_posix()
            for file in output_dir.rglob("*")
            if file.is_file()
        }

    problems: List[str] = []
    for manifest, reference in manifest_references(output_dir):
        if "://" in reference:
            continue
        target = reference.split("?", 1)[0].split("#", 1)[0].strip()
        if not target:
            continue
        if target.startswith("/"):
            candidate = target.lstrip("/")
        else:
            base = manifest.parent.relative_to(output_dir).as_posix()
            candidate = f"{base}/{target}" if base and base != "." else target
        candidate = _normalise(candidate)
        if candidate.startswith(".."):
            problems.append(f"{manifest.name} references {target} outside the package")
            continue
        if candidate and candidate not in known:
            problems.append(f"{manifest.name} references {target}, which was not packaged")

    if problems:
        preview = "; ".join(sorted(set(problems))[:5])
        raise TranscodeError(
            ERROR_PACKAGING_FAILED,
            f"the packaged manifests reference missing files: {preview}",
        )


def _normalise(path: str) -> str:
    parts: List[str] = []
    for segment in path.replace("\\", "/").split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if not parts:
                return "../"
            parts.pop()
            continue
        parts.append(segment)
    return "/".join(parts)


def package_layout_problems(output_dir: Path) -> Sequence[str]:
    """Diagnostic helper: manifest references that would fail at playback time."""
    try:
        validate_manifest_references(output_dir)
    except TranscodeError as exc:
        return [exc.message]
    return []
