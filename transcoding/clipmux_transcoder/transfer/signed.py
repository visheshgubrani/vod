"""
Signed HTTP transfer — the local worker path.

The agent holds **no** storage credentials. The API mints short-lived presigned
URLs for the exact artifacts the agent registered, and this backend PUTs to
them. Two properties matter and both are enforced here rather than trusted:

- *Bounded*: a URL is only ever requested for a path that came back from the
  API's grant call. The agent cannot invent a destination.
- *Renewable while authorized*: a long upload that outlives its grant asks for
  a fresh URL through ``renew``, which the API refuses once the attempt no
  longer owns the job. An expired grant therefore stops work instead of
  silently uploading into a prefix that has been superseded.

``requests`` is imported lazily so importing the engine does not require it.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Dict, List, Mapping

from clipmux_transcoder.transfer.base import (
    TransferError,
    TransferStats,
    content_type_for,
    order_for_publication,
)

# HTTP statuses that mean "ask for a fresh URL and try again" rather than
# "this artifact is broken". 403 is what a presigned URL that ran out of time
# returns; 400 can be a signature/clock skew on some S3 implementations.
EXPIRED_GRANT_STATUSES = frozenset({400, 403, 408, 429})


class GrantExpired(Exception):
    """The presigned URL was rejected as expired/invalid; a fresh one is needed."""


class SignedHttpTransfer:
    """
    Uploads artifacts by PUTting to per-path presigned URLs.

    ``grants`` maps a relative artifact path to its current presigned URL.
    ``renew`` is called (at most once per path) when a PUT is rejected with an
    expired-grant status; it returns a replacement URL or ``None`` when the API
    declines to renew — which is treated as a permanent failure for that
    artifact, because continuing would mean writing under an attempt that no
    longer owns the job.
    """

    def __init__(
        self,
        grants: Mapping[str, str],
        *,
        renew: Callable[[List[str]], Dict[str, str]] | None = None,
        max_workers: int = 4,
        timeout: float = 600.0,
        session=None,
    ) -> None:
        self._grants: Dict[str, str] = {str(k): str(v) for k, v in grants.items()}
        self._renew = renew
        self.max_workers = max_workers
        self.timeout = timeout
        self._session = session

    @property
    def session(self):
        if self._session is None:
            import requests

            self._session = requests.Session()
        return self._session

    def granted_paths(self) -> List[str]:
        return sorted(self._grants)

    def _put(self, relative_path: str, url: str, local: Path) -> None:
        content_type, cache_control = content_type_for(relative_path)
        with open(local, "rb") as handle:
            response = self.session.put(
                url,
                data=handle,
                headers={
                    "Content-Type": content_type,
                    "Cache-Control": cache_control,
                    # Required by S3 presigned PUTs that were signed with the
                    # header; harmless otherwise.
                    "Content-Length": str(local.stat().st_size),
                },
                timeout=self.timeout,
            )
        if response.status_code >= 400:
            if response.status_code in EXPIRED_GRANT_STATUSES:
                raise GrantExpired(f"HTTP {response.status_code}")
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:200]}")

    def upload_artifacts(
        self,
        output_dir: Path,
        relative_paths: List[str],
        *,
        already_uploaded: frozenset[str] = frozenset(),
    ) -> TransferStats:
        # An artifact with no grant is a permanent failure: the API declined to
        # authorize this path for this attempt, and guessing a URL is exactly
        # the confused-deputy behaviour the grant exists to prevent.
        pending = [
            path
            for path in order_for_publication(list(relative_paths))
            if path not in already_uploaded
        ]
        stats = TransferStats(
            total=len(relative_paths),
            skipped=len(relative_paths) - len(pending),
        )

        def upload_one(relative_path: str) -> TransferError | None:
            local = output_dir / relative_path
            url = self._grants.get(relative_path)
            if not url:
                return TransferError(path=relative_path, message="no upload grant issued")
            try:
                self._put(relative_path, url, local)
            except GrantExpired:
                if self._renew is None:
                    return TransferError(path=relative_path, message="upload grant expired")
                refreshed = self._renew([relative_path])
                replacement = refreshed.get(relative_path)
                if not replacement:
                    return TransferError(
                        path=relative_path,
                        message="upload grant expired and was not renewed",
                    )
                self._grants[relative_path] = replacement
                try:
                    self._put(relative_path, replacement, local)
                except Exception as exc:  # noqa: BLE001 — reported per artifact
                    return TransferError(path=relative_path, message=str(exc))
            except Exception as exc:  # noqa: BLE001 — reported per artifact
                return TransferError(path=relative_path, message=str(exc))
            return None

        if not pending:
            return stats

        with ThreadPoolExecutor(max_workers=min(self.max_workers, len(pending))) as pool:
            for result in pool.map(upload_one, pending):
                if result is None:
                    stats.uploaded += 1
                else:
                    stats.failed.append(result)
        return stats
