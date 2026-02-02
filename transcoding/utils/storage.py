"""
Storage utilities for R2/S3 uploads.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from config import R2_PREFIX, TRANSFER_CONFIG


def upload_to_r2(
    output_dir: Path,
    video_id: str,
    s3_client,
    bucket: str,
    playback_policy: str = "public",
    organization_id: str = None
) -> int:
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
    
    files = list(output_dir.glob("*"))
    
    def upload_file(file_path: Path) -> bool:
        r2_key = f"{R2_PREFIX}/{video_id}/{file_path.name}"
        
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
        uploaded = sum(results)
    
    print(f"✅ Uploaded {uploaded}/{len(files)} files")
    return uploaded

