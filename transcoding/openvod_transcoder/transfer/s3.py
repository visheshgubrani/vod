"""
S3/R2 transfer — the Modal execution path.

Credentials come from the environment of the runner (a Modal secret today),
which is exactly why this backend is *not* the one self-hosted agents use: an
agent runs on a machine the owner also uses, and long-lived R2 keys there are a
much larger blast radius than a short-lived presigned URL.

``boto3`` is imported lazily so importing the engine never requires it.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List

from openvod_transcoder.config import R2_PREFIX
from openvod_transcoder.transfer.base import (
    TransferError,
    TransferStats,
    content_type_for,
    order_for_publication,
)


def s3_config():
    """botocore Config for R2 (adaptive retries, a pool sized for parallel parts)."""
    from botocore.config import Config

    return Config(max_pool_connections=100, retries={"max_attempts": 3, "mode": "adaptive"})


def transfer_config():
    """Multi-threaded transfer config for large uploads and downloads."""
    from boto3.s3.transfer import TransferConfig

    return TransferConfig(
        multipart_threshold=8 * 1024 * 1024,
        max_concurrency=10,
        multipart_chunksize=8 * 1024 * 1024,
        use_threads=True,
    )


class S3Transfer:
    """Uploads packaged artifacts to a bucket with the pipeline's key layout."""

    def __init__(
        self,
        client,
        bucket: str,
        *,
        prefix: str = R2_PREFIX,
        key_root: str | None = None,
        video_id: str = "",
        playback_policy: str = "public",
        organization_id: str | None = None,
        max_workers: int = 50,
        transfer=None,
    ) -> None:
        self.client = client
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        # `key_root` is the attempt-scoped base (`videos/<id>/attempts/<attempt>`).
        # When absent the legacy `videos/<video-id>` layout is used, which is what
        # keeps existing Modal jobs byte-compatible during a rolling upgrade.
        self.key_root = (key_root or f"{self.prefix}/{video_id}").strip("/")
        self.video_id = video_id
        self.playback_policy = playback_policy
        self.organization_id = organization_id
        self.max_workers = max_workers
        self._transfer = transfer

    def key_for(self, relative_path: str) -> str:
        return f"{self.key_root}/{str(relative_path).lstrip('/')}"

    def upload_artifacts(
        self,
        output_dir: Path,
        relative_paths: List[str],
        *,
        already_uploaded: frozenset[str] = frozenset(),
    ) -> TransferStats:
        pending = [
            path
            for path in order_for_publication(list(relative_paths))
            if path not in already_uploaded
        ]
        stats = TransferStats(
            total=len(relative_paths),
            skipped=len(relative_paths) - len(pending),
        )

        kwargs = {}
        if self._transfer is not None:
            kwargs["Config"] = self._transfer

        def upload_one(relative_path: str) -> TransferError | None:
            local = output_dir / relative_path
            content_type, cache_control = content_type_for(relative_path)
            metadata = {
                "video-id": self.video_id,
                "original-name": local.name,
                "playback-policy": self.playback_policy,
            }
            if self.organization_id:
                metadata["organization-id"] = self.organization_id
            try:
                self.client.upload_file(
                    str(local),
                    self.bucket,
                    self.key_for(relative_path),
                    ExtraArgs={
                        "ContentType": content_type,
                        "CacheControl": cache_control,
                        "Metadata": metadata,
                    },
                    **kwargs,
                )
                return None
            except Exception as exc:  # noqa: BLE001 — reported per artifact, not raised
                return TransferError(path=relative_path, message=str(exc))

        if not pending:
            return stats

        with ThreadPoolExecutor(max_workers=min(self.max_workers, len(pending))) as pool:
            for result in pool.map(upload_one, pending):
                if result is None:
                    stats.uploaded += 1
                else:
                    stats.failed.append(result)
        return stats


def client_from_env(env: dict | None = None):
    """Build an R2 S3 client from R2_* environment variables."""
    import os

    import boto3

    values = env if env is not None else os.environ
    account_id = values.get("R2_ACCOUNT_ID", "")
    access_key = values.get("R2_ACCESS_KEY_ID", "")
    secret_key = values.get("R2_SECRET_ACCESS_KEY", "")
    if not account_id or not access_key or not secret_key:
        raise RuntimeError(
            "Missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY"
        )

    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=s3_config(),
    )
