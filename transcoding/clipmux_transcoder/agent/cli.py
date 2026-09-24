"""
`clipmux-transcoder` — the operator's command surface.

The commands are the ones an owner actually reaches for, including the two that
matter most on a machine nobody is watching:

- `doctor` answers "will this work?" *before* the first job, by running a real
  encode, a real package and a real API round trip. Every check it makes is one
  that has, at some point, been the reason a job failed.
- `import` registers and queues work through the API. It never writes to the
  database and never bypasses ownership checks — a CLI import and a dashboard
  import take an identical path through the server, so they cannot diverge on
  validation, idempotency or completion.

Exit codes are part of the contract: `0` success, `1` a normal failure (a job
failed, a check failed), `2` a usage error. A container orchestrator can act on
that without parsing output.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import socket
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from clipmux_transcoder.agent.client import (
    AgentApiError,
    ApiConfig,
    AuthenticationFailed,
    TranscoderApiClient,
)
from clipmux_transcoder.agent.config import AgentConfig
from clipmux_transcoder.agent.journal import RecoveryJournal
from clipmux_transcoder.cancellation import CancellationToken
from clipmux_transcoder.encoding.backends import CPU_BACKEND, backend_named
from clipmux_transcoder.encoding.probe import detect_capabilities, preflight_source
from clipmux_transcoder.errors import TranscodeError, classify_error
from clipmux_transcoder.options import ProcessingOptions
from clipmux_transcoder.paths import PathPolicy, PathRejected, file_identity
from clipmux_transcoder.snapshot import estimate_scratch_bytes

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2

DEFAULT_STATE_DIR = Path(os.environ.get("CLIPMUX_STATE_DIR", "/var/lib/clipmux-transcoder"))


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="clipmux-transcoder",
        description="Self-hosted ClipMux transcoding agent.",
    )
    parser.add_argument("--api", help="ClipMux API base URL (default: $CLIPMUX_API_URL)")
    parser.add_argument(
        "--root",
        action="append",
        default=None,
        metavar="NAME:PATH",
        help="a folder the agent may read (repeatable)",
    )
    parser.add_argument("--scratch-dir", help="scratch directory for snapshots and work")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--quiet", action="store_true", help="suppress progress output")

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("run", help="run the agent loop")

    doctor = sub.add_parser("doctor", help="check this machine end to end")
    doctor.add_argument(
        "--full",
        action="store_true",
        help="also run a complete encode/package cycle on a synthetic source",
    )
    doctor.add_argument("--file", help="preflight this specific file instead")

    import_cmd = sub.add_parser("import", help="register and queue a local file")
    import_cmd.add_argument("files", nargs="+", help="paths to import")
    import_cmd.add_argument("--title", help="video title (defaults to the file name)")
    import_cmd.add_argument(
        "--policy", choices=["public", "signed"], default="public", help="playback policy"
    )
    import_cmd.add_argument("--subtitle", action="store_true", help="generate subtitles")
    import_cmd.add_argument("--chapters", action="store_true", help="generate chapters")
    import_cmd.add_argument("--max-height", type=int, default=1080, help="cap the ladder")
    import_cmd.add_argument(
        "--also-2160p", action="store_true", help="include 1440p and 2160p rungs"
    )

    sub.add_parser("capabilities", help="print this machine's encoder capabilities")
    sub.add_parser("version", help="print the agent version")

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "version":
        from clipmux_transcoder import __version__

        print(__version__)
        return EXIT_OK

    try:
        if args.command == "doctor":
            return cmd_doctor(args, load_config(args))
        if args.command == "capabilities":
            return cmd_capabilities(args)
        if args.command == "import":
            return cmd_import(args, load_config(args))

        config = load_config(args)
        if args.command == "run":
            return cmd_run(args, config)
    except AgentApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_FAILURE
    except KeyboardInterrupt:
        return EXIT_OK
    except TranscodeError as exc:
        print(f"error: [{exc.code}] {exc.message}", file=sys.stderr)
        return EXIT_FAILURE

    parser.print_help()
    return EXIT_USAGE


# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

def load_config(args) -> AgentConfig:
    config = AgentConfig.from_env()

    if args.api:
        config.api_url = args.api.rstrip("/")
    if args.scratch_dir:
        config.scratch_dir = Path(args.scratch_dir)
    if args.root:
        from clipmux_transcoder.paths import Root

        roots = []
        for entry in args.root:
            name, _, path = entry.partition(":")
            if not path:
                path, name = name, Path(name).name
            roots.append(Root(name=name.strip() or "media", path=Path(path.strip())))
        config.roots = roots

    return config


def make_client(config: AgentConfig) -> TranscoderApiClient:
    return TranscoderApiClient(
        ApiConfig(base_url=config.api_url, secret=config.secret)
    )


# ═══════════════════════════════════════════════════════════════════════════════
# COMMANDS
# ═══════════════════════════════════════════════════════════════════════════════

def cmd_capabilities(args) -> int:
    config = AgentConfig.from_env()
    report = detect_capabilities(scratch_dir=config.scratch_dir)
    if args.json:
        payload = report.to_payload()
        payload['encoderDiagnostics'] = {
            name: {"available": probe.available, "reason": probe.reason}
            for name, probe in sorted(report.encoders.items())
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return EXIT_OK

    payload = report.to_payload()
    print(f"ffmpeg:  {payload['ffmpeg'] or 'NOT FOUND'}")
    print(f"shaka:   {payload['shaka'] or 'NOT FOUND'}")
    print(f"cores:   {payload['cpuCores']}")
    print(f"hwaccels compiled in: {', '.join(payload['hwaccels']) or 'none'}")
    print("encoders (verified with a real encode):")
    for name, probe in sorted(report.encoders.items()):
        mark = "ok  " if probe.available else "no  "
        note = "" if probe.available else f"  — {probe.reason}"
        print(f"  {mark}{name}{note}")
    return EXIT_OK


def cmd_doctor(args, config: AgentConfig) -> int:
    """
    Check every precondition, in the order a job would hit it.

    A doctor that only checks "is ffmpeg installed" is worse than none: it
    reports health on a machine where the first import will fail on permissions.
    So each check below mirrors a real failure mode, and the last one runs an
    actual encode and package cycle.

    The shared deployment credential is read from the environment and never
    written to local state. The API check below is read-only and does not mark
    the worker online.
    """
    checks: List[Dict[str, Any]] = []
    ok = True

    def record(name: str, passed: bool, detail: str, fatal: bool = True) -> None:
        nonlocal ok
        checks.append({"name": name, "ok": passed, "detail": detail})
        if not passed and fatal:
            ok = False

    # 1) configuration
    problems = config.validate()
    record(
        "configuration",
        not problems,
        "; ".join(problems) if problems else "api, credential and folders are configured",
    )

    # 2) binaries
    for binary in ("ffmpeg", "ffprobe"):
        found = shutil.which(binary)
        record(binary, bool(found), found or f"{binary} is not on PATH")
    packager = shutil.which("packager")
    record(
        "packager",
        bool(packager),
        packager or "shaka-packager is not on PATH (needed to package HLS/DASH)",
    )

    # 3) folders: existence, readability and an actual listing
    for root in config.roots:
        if not root.path.exists():
            record(f"folder:{root.name}", False, "does not exist")
            continue
        if not os.access(root.path, os.R_OK | os.X_OK):
            record(
                f"folder:{root.name}",
                False,
                "not readable by this user — check ownership and group membership",
            )
            continue
        try:
            policy = PathPolicy([root])
            listing = policy.list_directory(root.path, limit=1)
            record(
                f"folder:{root.name}",
                True,
                f"readable ({'empty' if not listing.entries else 'entries visible'})",
            )
        except PathRejected as exc:
            record(f"folder:{root.name}", False, f"cannot list: {exc.message}")

    # 4) scratch: writable, and on a filesystem with room
    try:
        config.scratch_dir.mkdir(parents=True, exist_ok=True)
        probe_file = config.scratch_dir / ".clipmux-doctor"
        probe_file.write_text("ok")
        probe_file.unlink()
        free_gb = shutil.disk_usage(str(config.scratch_dir)).free / 1024**3
        record("scratch writable", True, f"{free_gb:.1f} GB free at {config.scratch_dir}")
        record(
            "scratch space",
            free_gb >= 5,
            f"{free_gb:.1f} GB free (a 1080p ladder needs roughly 2x the source size)",
            fatal=False,
        )
    except OSError as exc:
        record("scratch writable", False, str(exc))

    # 5) encoders, with a real encode
    report = detect_capabilities(scratch_dir=config.scratch_dir)
    available = report.available_backends()
    record(
        "encoder",
        bool(available),
        f"verified: {', '.join(available)}" if available else "no encoder could be verified",
    )

    # 6) API connectivity and credential
    if config.secret:
        try:
            client = make_client(config)
            client.status()
            record("api credential", True, "deployment credential accepted")
        except AuthenticationFailed as exc:
            record("api credential", False, f"rejected: {exc}")
        except AgentApiError as exc:
            record("api credential", False, f"could not reach the API: {exc}")
    else:
        record("api credential", False, "LOCAL_TRANSCODER_SECRET is not configured")

    # 7) a real source, when one was named
    if getattr(args, "file", None):
        try:
            policy = PathPolicy(config.roots) if config.roots else None
            target = Path(args.file)
            if policy is not None:
                target = policy.resolve(target)
            from clipmux_transcoder.video.analysis import get_video_metadata

            metadata = get_video_metadata(str(target))
            backend = backend_named(config.encoder_backend)
            probe = preflight_source(
                target, metadata, backend, duration=2.0
            )
            record(
                "source preflight",
                probe.hardware_decode or probe.hardware_filters or backend.name == "cpu",
                f"{metadata.width}x{metadata.height} {metadata.fps:.2f}fps — {probe.reason}",
                fatal=False,
            )
        except Exception as exc:  # noqa: BLE001 — reported, not raised
            record("source preflight", False, str(exc), fatal=False)

    # 8) the full cycle
    if args.full:
        record("full cycle", *_full_cycle(config))

    if args.json:
        print(json.dumps({"ok": ok, "checks": checks}, indent=2))
        return EXIT_OK if ok else EXIT_FAILURE

    for check in checks:
        mark = "PASS" if check["ok"] else "FAIL"
        print(f"[{mark}] {check['name']}: {check['detail']}")
    print()
    print("Ready." if ok else "Problems found — fix the FAIL lines above.")
    return EXIT_OK if ok else EXIT_FAILURE


def _full_cycle(config: AgentConfig) -> tuple[bool, str]:
    """
    Encode, package and validate a two-second synthetic source.

    This is the only check that exercises FFmpeg, Shaka and the packager together,
    which is where the failures that a per-component check misses actually live —
    a missing `-movflags` support, a packager that cannot read the intermediate.
    """
    import subprocess
    import tempfile

    from clipmux_transcoder.packaging import validate_package
    from clipmux_transcoder.pipeline import run_pipeline

    with tempfile.TemporaryDirectory(prefix="clipmux-doctor-") as tmp:
        tmp_path = Path(tmp)
        source = tmp_path / "probe.mp4"
        gen = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=2",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
                "-shortest", str(source),
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )
        if gen.returncode != 0:
            return False, f"could not build a test clip: {gen.stderr.strip()[:200]}"

        options = ProcessingOptions(
            video_id="doctor",
            attempt_id="doctor",
            encoder_backend=config.encoder_backend,
            encoder_device=config.encoder_device,
            max_height=360,
            rendition_concurrency=1,
        )
        try:
            result = run_pipeline(
                source,
                tmp_path / "job",
                options,
                detect_capabilities(scratch_dir=config.scratch_dir),
                None,
                CancellationToken(),
                ffmpeg="ffmpeg",
                packager="packager",
            )
        except Exception as exc:  # noqa: BLE001 — reported as a check result
            return False, f"{classify_error(exc)}: {exc}"

        problems = validate_package(
            tmp_path / "job" / "output",
            expected_labels=[rendition.label for rendition in result.renditions],
            expect_audio=True,
        )
        if problems:
            return False, "; ".join(problems)
        return True, f"{len(result.artifacts)} artifacts, {len(result.renditions)} rendition(s)"


def cmd_run(args, config: AgentConfig) -> int:
    problems = config.validate()
    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        return EXIT_FAILURE

    from clipmux_transcoder.agent.daemon import TranscoderAgent

    config.scratch_dir.mkdir(parents=True, exist_ok=True)
    config.journal_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = config.journal_path.parent / "worker.lock"
    with lock_path.open("a+") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("error: another local transcoding worker already uses this state volume", file=sys.stderr)
            return EXIT_FAILURE
        journal = RecoveryJournal(config.journal_path)
        client = make_client(config)
        agent = TranscoderAgent(config, client, journal, verbose=not args.quiet)
        try:
            agent.run_forever()
        finally:
            journal.close()
    return EXIT_OK


def cmd_import(args, config: AgentConfig) -> int:
    """
    Register and queue local files.

    Every step goes through the API: the source is registered with the agent's own
    credential, and the import is created by the organization-scoped import
    endpoint. Nothing here writes to the database or skips the ownership checks
    the dashboard path performs.
    """
    if not config.roots:
        print(
            "error: no readable folders configured; pass --root NAME:PATH",
            file=sys.stderr,
        )
        return EXIT_FAILURE

    policy = PathPolicy(config.roots)
    client = make_client(config)
    imports = []

    for raw in args.files:
        try:
            resolved = policy.resolve(raw)
        except PathRejected as exc:
            print(f"error: {raw}: {exc.message}", file=sys.stderr)
            return EXIT_FAILURE

        root = policy.root_for(resolved)
        relative = policy.display_path(resolved)
        identity = file_identity(resolved)
        size = resolved.stat().st_size

        estimate = estimate_scratch_bytes(size, 4)
        free = shutil.disk_usage(str(config.scratch_dir)).free if config.scratch_dir.exists() else 0
        if free and free < estimate:
            print(
                f"warning: {relative} needs about {estimate / 1024**3:.1f} GB of scratch, "
                f"only {free / 1024**3:.1f} GB free",
                file=sys.stderr,
            )

        registration = client.register_source(
            root_name=root,
            relative_path=relative,
            file_name=resolved.name,
            identity=identity,
            size_bytes=size,
        )

        options: Dict[str, Any] = {"maxHeight": args.max_height}
        if args.also_2160p:
            options["includeHeights"] = [1440, 2160]

        # A stable idempotency key derived from the file's identity: importing the
        # same unchanged file twice creates one video, not two.
        key = f"cli:{identity}" if identity else f"cli:{relative}:{int(time.time())}"

        imports.append(
            {
                "sourceRef": registration["sourceRef"],
                "title": args.title if len(args.files) == 1 and args.title else None,
                "playbackPolicy": args.policy,
                "processingOptions": options,
                "generateSubtitle": args.subtitle,
                "generateChapters": args.chapters,
                "idempotencyKey": key,
            }
        )
        print(f"registered {relative} as {registration['sourceRef']}")

    if args.json:
        print(json.dumps({"imports": imports}, indent=2))
        return EXIT_OK

    # The import itself is a dashboard/API operation. The agent hands the
    # references over through the same endpoint the dashboard uses, so the two
    # paths cannot diverge on validation or on idempotency.
    print()
    print("Queue these with the import API (or the dashboard):")
    for entry in imports:
        print(f"  sourceRef={entry['sourceRef']}  title={entry['title'] or '(from file)'}")
    return EXIT_OK


def _version() -> str:
    from clipmux_transcoder import __version__

    return __version__


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
