"""Image build helpers, importable before the pipeline modules are attached.

These run at *image build* time, on the Modal side, where the engine package may
not be importable yet — which is why they live in their own module and import
nothing from `openvod_transcoder`.

They also run at *container start* time: `main.py` imports this module, and the
image's package lists are read from the recipe as the image is constructed. That
is why `resolve_toolchain_file` exists — see its docstring.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import List, Sequence

TOOLCHAIN_IN_IMAGE = Path("/opt/openvod/toolchain")


def toolchain_root(module_file: str) -> Path:
    """The directory holding `toolchain/`, given a mounted source file.

    A separate function so the *container* layout can be reproduced in tests:
    inside a container `module_file` is `/root/main.py`, and `/root` has no
    `toolchain/` — which is precisely the difference that broke a deploy.
    """
    return Path(module_file).parent


def resolve_toolchain_file(
    name: str,
    *,
    module_file: str | None = None,
    roots: Sequence[Path] | None = None,
) -> Path:
    """
    Locate a file of the media-toolchain recipe, in the checkout *or* a container.

    The recipe is at a different path in each, and that difference is a bug class
    rather than a detail. At deploy time `main.py` runs from `transcoding/`, so
    the recipe is the sibling directory `toolchain/`. Inside a container the
    Modal CLI mounts `main.py` and `image_build.py` as *loose files at /root*,
    so `Path(__file__).parent / "toolchain"` is empty there — the directory
    exists only where the image baked it, at the `remote_path` of `main.py`'s
    `add_local_dir(..., copy=True)` call.

    Reading the checkout path unconditionally therefore passes on the deploy
    machine and then fails to hydrate *every* function of the deployed app:

        File "/root/main.py", line 110, in <module>
          _BUILD_PACKAGES = read_package_list(_TOOLCHAIN_DIR / "apt-packages.env", ...)
        FileNotFoundError: [Errno 2] '/root/toolchain/apt-packages.env'

    Resolution order: `OPENVOD_TOOLCHAIN_DIR` (a relocated copy, explicit), then
    the checkout beside this module (deploy time, `modal run`, tests), then the
    path the image baked (`TOOLCHAIN_IN_IMAGE`). `module_file` and `roots` exist
    so tests can reproduce the container's layout; production callers pass only
    `name`.
    """
    source = module_file or __file__
    candidates: List[Path] = []
    override = os.environ.get("OPENVOD_TOOLCHAIN_DIR")
    if override:
        # An explicit destination wins over the checkout — that is what an
        # override is for. It is *not* a hard failure when it is stale: falling
        # through to a root that does hold the recipe keeps a stray environment
        # variable from breaking a deploy.
        candidates.append(Path(override) / name)
    candidates.append(toolchain_root(source) / "toolchain" / name)
    candidates.extend(root / name for root in (roots or (TOOLCHAIN_IN_IMAGE,)))

    for candidate in candidates:
        if candidate.is_file():
            return candidate

    # Name every candidate: the original deployed failure was a bare ENOENT for
    # one path, which said nothing about where the file actually was.
    tried = "\n  ".join(str(candidate) for candidate in candidates)
    raise FileNotFoundError(
        f"{name} not found in the media toolchain recipe. Tried:\n  {tried}\n"
        f"A container gets the recipe from the image build's add_local_dir "
        f"remote_path, which must match TOOLCHAIN_IN_IMAGE."
    )


def read_package_list(path: str | Path, variable: str) -> List[str]:
    """
    Read a bash array (`NAME=(a b c)`) out of a `.env` file.

    The image's package lists live in `toolchain/apt-packages.env` so that the
    Modal image and the self-hosted agent image install the *same* libraries —
    the whole point of one shared recipe. Parsing the file rather than repeating
    the list here keeps them from drifting; a list that lives twice is a list
    that is wrong once.
    """
    text = Path(path).read_text(encoding="utf-8")
    match = re.search(
        rf"^{re.escape(variable)}=\((.*?)^\)", text, re.MULTILINE | re.DOTALL
    )
    if not match:
        raise ValueError(f"{variable} not found in {path}")
    packages = []
    for line in match.group(1).splitlines():
        entry = line.split("#", 1)[0].strip()
        if entry:
            packages.append(entry)
    if not packages:
        raise ValueError(f"{variable} in {path} is empty")
    return packages


def download_whisper_weights() -> None:
    """Bake Whisper weights into the image (Modal run_function, 1h timeout)."""
    from faster_whisper.utils import download_model

    # Resolve the same alias as WhisperModel at runtime, including its cache key.
    # The default model is public and requires no Hugging Face credentials.
    download_model("large-v3-turbo", use_auth_token=False)
