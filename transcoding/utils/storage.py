"""
Storage utilities for R2/S3 uploads.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from dataclasses import dataclass, field
from typing import List

from config import R2_PREFIX, TRANSFER_CONFIG


@dataclass
class UploadStats:
    """Outcome of an R2 upload pass."""
    total: int = 0
    uploaded: int = 0
    failed: List[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return self.uploaded == self.total and self.failed == []


def upload_to_r2(
    output_dir: Path,
    video_id: str,
    s3_client,
    bucket: str,
    playback_policy: str = "public",
    organization_id: str = None
) -> UploadStats:
    """
    Upload packaged files to R2 with proper metadata.
    
    Args:
        output_dir: Directory containing files to upload
        video_id: Video ID for R2 key prefix
        s3_client: Configured boto3 S3 client
        bucket: R2 bucket name
        playback_policy: "public" or "signed" - stored in metadata for delivery worker
        organization_id: Organization ID for bandwidth analytics tracking
        
    Returns:
        Number of files successfully uploaded
    """
    print("☁️ Uploading to R2...")
    
    files = [f for f in output_dir.rglob("*") if f.is_file()]
    
    def upload_file(file_path: Path) -> bool:
        # Preserve directory structure in R2 key (e.g. video_1080p/init.mp4)
        relative = file_path.relative_to(output_dir)
        r2_key = f"{R2_PREFIX}/{video_id}/{relative}"
        
        # Content-Type and Cache-Control mapping
        ext = file_path.suffix.lower()
        content_types = {
            ".m3u8": ("application/vnd.apple.mpegurl", "public, max-age=60"),
            ".mpd": ("application/dash+xml", "public, max-age=60"),
            ".mp4": ("video/mp4", "public, max-age=31536000, immutable"),
            ".m4s": ("video/iso.segment", "public, max-age=31536000, immutable"),
            ".jpg": ("image/jpeg", "public, max-age=31536000, immutable"),
            ".vtt": ("text/vtt", "public, max-age=31536000, immutable"),
            ".key": ("application/octet-stream", "private, no-store, max-age=0"),
        }
        
        content_type, cache_control = content_types.get(
            ext,
            ("application/octet-stream", "public, max-age=3600")
        )
        
        # Build metadata dict with optional organization-id
        metadata = {
            "video-id": video_id,
            "original-name": file_path.name,
            "playback-policy": playback_policy,
        }
        if organization_id:
            metadata["organization-id"] = organization_id
        
        try:
            s3_client.upload_file(
                str(file_path),
                bucket,
                r2_key,
                ExtraArgs={
                    "ContentType": content_type,
                    "CacheControl": cache_control,
                    "Metadata": metadata
                },
                Config=TRANSFER_CONFIG  # Use multi-threaded uploads
            )
            return True
        except Exception as e:
            print(f"❌ Upload failed for {file_path.name}: {e}")
            return False
    
    with ThreadPoolExecutor(max_workers=50) as executor:
        results = list(executor.map(upload_file, files))
    uploaded = sum(1 for r in results if r)
    failed = [f.name for f, ok in zip(files, results) if not ok]
    
    stats = UploadStats(total=len(files), uploaded=uploaded, failed=failed)
    print(f"✅ Uploaded {stats.uploaded}/{stats.total} files")
    if stats.failed:
        print(f"❌ Failed uploads: {', '.join(stats.failed)}")
    return stats

