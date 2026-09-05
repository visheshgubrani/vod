#!/usr/bin/env python3
"""Helpers for scripts/bootstrap.sh. Do not print secret values."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def _die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def patch_delivery_bucket(repo: Path, bucket: str) -> None:
    path = repo / "delivery" / "wrangler.jsonc"
    text = path.read_text()
    updated, n = re.subn(
        r'("bucket_name"\s*:\s*")[^"]+(")',
        rf"\g<1>{bucket}\2",
        text,
        count=1,
    )
    if n != 1:
        _die(f"could not patch bucket_name in {path}")
    path.write_text(updated)


def upsert_env(file: Path, key: str, value: str) -> None:
    file.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    if file.exists():
        lines = file.read_text().splitlines()
    prefix = f"{key}="
    found = False
    out: list[str] = []
    for line in lines:
        if line.startswith(prefix):
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        if out and out[-1] != "":
            out.append(f"{key}={value}")
        else:
            out.append(f"{key}={value}")
    file.write_text("\n".join(out) + "\n")


def parse_account_id(text: str) -> str:
    ids = re.findall(r"\b[0-9a-f]{32}\b", text.lower())
    if not ids:
        _die("could not parse Cloudflare account id from wrangler whoami")
    return ids[0]


def parse_workers_url(text: str) -> str:
    urls = re.findall(r"https://[a-z0-9._-]+\.workers\.dev", text, re.I)
    if not urls:
        _die("could not parse workers.dev URL from wrangler deploy output")
    return urls[-1].rstrip("/")


def parse_modal_url(text: str) -> str:
    urls = re.findall(r"https://[^\s]+modal\.run[^\s]*", text, re.I)
    if not urls:
        _die("could not parse Modal URL from deploy output")
    preferred = [u.rstrip(").,") for u in urls if "transcode" in u.lower()]
    return (preferred[0] if preferred else urls[0].rstrip(").,"))


def modal_secret(name: str, json_path: Path) -> None:
    env_dict = json.loads(json_path.read_text())
    if not isinstance(env_dict, dict) or not env_dict:
        _die("secret json must be a non-empty object")

    import shutil
    import subprocess

    subprocess.run(
        ["modal", "secret", "delete", name, "-y"],
        check=False,
        capture_output=True,
    )

    # Attempt 1: modal CLI (works when modal is installed via pipx or another python env)
    if shutil.which("modal"):
        cmd = ["modal", "secret", "create", name]
        for k, v in env_dict.items():
            cmd.append(f"{k}={v}")
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0:
            return

    # Attempt 2: Python SDK
    try:
        from modal import Secret  # type: ignore[import-untyped]
        objects = getattr(Secret, "objects", None)
        create = getattr(objects, "create", None) if objects is not None else None
        if create is not None:
            try:
                create(name, env_dict)
                return
            except TypeError:
                create(name, env_dict, allow_existing=True)
                return
    except ImportError:
        pass

    _die(f"could not create modal secret '{name}' (neither modal CLI nor modal python package succeeded)")


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        _die("usage: openvod_setup.py <command> ...")
    cmd = argv[1]
    if cmd == "patch-delivery-bucket":
        patch_delivery_bucket(Path(argv[2]), argv[3])
    elif cmd == "upsert-env":
        upsert_env(Path(argv[2]), argv[3], argv[4])
    elif cmd == "parse-account-id":
        print(parse_account_id(sys.stdin.read()))
    elif cmd == "parse-workers-url":
        print(parse_workers_url(sys.stdin.read()))
    elif cmd == "parse-modal-url":
        print(parse_modal_url(sys.stdin.read()))
    elif cmd == "modal-secret":
        modal_secret(argv[2], Path(argv[3]))
    else:
        _die(f"unknown command: {cmd}")


if __name__ == "__main__":
    main(sys.argv)
