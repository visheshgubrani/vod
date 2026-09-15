"""Source snapshots: copy/clone, hashing, change detection, scratch estimation."""
import os
import time
from pathlib import Path

import pytest

from clipmux_transcoder.errors import (
    ERROR_INSUFFICIENT_DISK,
    ERROR_SOURCE_CHANGED,
    ERROR_SOURCE_MISSING,
    TranscodeError,
)
from clipmux_transcoder.result import sha256_file
from clipmux_transcoder.snapshot import (
    SnapshotPolicy,
    cleanup_snapshot,
    create_snapshot,
    ensure_scratch,
    estimate_scratch_bytes,
    is_same_file,
    original_untouched,
)


@pytest.fixture()
def media(tmp_path: Path) -> Path:
    source = tmp_path / "originals" / "lesson-01.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"clipmux" * 4096)
    return source


class TestEstimateScratch:
    def test_estimate_exceeds_source_plus_outputs(self):
        estimate = estimate_scratch_bytes(100 * 1024**2, 4)
        assert estimate > 100 * 1024**2

    def test_more_renditions_cost_more(self):
        assert estimate_scratch_bytes(100 * 1024**2, 6) > estimate_scratch_bytes(100 * 1024**2, 1)

    def test_floor_keeps_small_jobs_from_failing_on_headroom(self):
        assert estimate_scratch_bytes(0, 1) >= 512 * 1024**2


class TestEnsureScratch:
    def test_absurd_requirement_is_reported_as_insufficient_disk(self, tmp_path: Path):
        with pytest.raises(TranscodeError) as caught:
            ensure_scratch(tmp_path, 10**18)
        assert caught.value.code == ERROR_INSUFFICIENT_DISK
        assert "insufficient scratch space" in caught.value.message

    def test_reasonable_requirement_passes(self, tmp_path: Path):
        ensure_scratch(tmp_path, 1024)


class TestCreateSnapshot:
    def test_snapshot_matches_the_source_bytes(self, media: Path, tmp_path: Path):
        destination = tmp_path / "work" / "source.mp4"
        snapshot = create_snapshot(media, destination)
        assert snapshot.path.read_bytes() == media.read_bytes()
        assert snapshot.size_bytes == media.stat().st_size
        assert snapshot.sha256 == sha256_file(destination)
        assert snapshot.method in ("reflink", "copy")

    def test_result_is_content_addressed_deterministically(self, media: Path, tmp_path: Path):
        first = create_snapshot(media, tmp_path / "a.mp4")
        second = create_snapshot(media, tmp_path / "b.mp4")
        assert first.sha256 == second.sha256

    def test_reusable_key_binds_content_and_plan(self, media: Path, tmp_path: Path):
        snapshot = create_snapshot(media, tmp_path / "a.mp4")
        assert snapshot.reusable_key("plan-abc") == f"{snapshot.sha256}:plan-abc"

    def test_missing_source_is_typed_so_the_dashboard_can_offer_reselection(
        self, tmp_path: Path
    ):
        with pytest.raises(TranscodeError) as caught:
            create_snapshot(tmp_path / "gone.mp4", tmp_path / "snap.mp4")
        assert caught.value.code == ERROR_SOURCE_MISSING

    def test_changed_source_identity_is_refused_before_copying(self, media: Path, tmp_path: Path):
        from clipmux_transcoder.paths import file_identity

        stale = file_identity(media)
        media.write_bytes(b"different content now")
        with pytest.raises(TranscodeError) as caught:
            create_snapshot(media, tmp_path / "snap.mp4", expected_identity=stale)
        assert caught.value.code == ERROR_SOURCE_CHANGED

    def test_unchanged_identity_is_accepted(self, media: Path, tmp_path: Path):
        from clipmux_transcoder.paths import file_identity

        identity = file_identity(media)
        snapshot = create_snapshot(media, tmp_path / "snap.mp4", expected_identity=identity)
        assert snapshot.sha256

    def test_edit_during_copy_is_detected_and_the_partial_copy_removed(
        self, media: Path, tmp_path: Path
    ):
        destination = tmp_path / "snap.mp4"
        edited = {"done": False}

        def on_progress(_fraction):
            if not edited["done"]:
                edited["done"] = True
                # Rewrite the original mid-copy, as a re-export would.
                time.sleep(0.01)
                media.write_bytes(b"re-exported" * 4096)

        with pytest.raises(TranscodeError) as caught:
            create_snapshot(
                media,
                destination,
                policy=SnapshotPolicy(allow_reflink=False, verify_chunk_bytes=64),
                on_progress=on_progress,
            )
        assert caught.value.code == ERROR_SOURCE_CHANGED
        assert not destination.exists()

    def test_hardlinks_are_never_used(self, media: Path, tmp_path: Path):
        # A hardlink shares the inode, so editing the original would change the
        # snapshot too — which defeats the whole mechanism.
        destination = tmp_path / "snap.mp4"
        create_snapshot(media, destination)
        assert not is_same_file(media, destination)
        media.write_bytes(b"edited in place")
        assert destination.read_bytes() != media.read_bytes()

    def test_original_is_left_exactly_as_it_was(self, media: Path, tmp_path: Path):
        before = media.read_bytes()
        snapshot = create_snapshot(media, tmp_path / "snap.mp4")
        assert original_untouched(snapshot, media) is True
        assert media.read_bytes() == before

    def test_cleanup_removes_only_the_snapshot(self, media: Path, tmp_path: Path):
        snapshot = create_snapshot(media, tmp_path / "snap.mp4")
        cleanup_snapshot(snapshot)
        assert not snapshot.path.exists()
        assert media.exists()


class TestFileIdentity:
    def test_identity_changes_when_size_changes(self, media: Path):
        from clipmux_transcoder.paths import file_identity

        before = file_identity(media)
        media.write_bytes(b"x" * 10)
        assert file_identity(media) != before

    def test_missing_file_has_no_identity(self, tmp_path: Path):
        from clipmux_transcoder.paths import file_identity

        assert file_identity(tmp_path / "nope.mp4") == ""


class TestSnapshotPolicyDefaults:
    def test_reflinks_are_attempted_but_not_required(self):
        assert SnapshotPolicy().allow_reflink is True

    def test_copy_is_single_pass_by_default(self):
        assert SnapshotPolicy().hash_while_copying is True


class TestNoLeakedHandles:
    def test_snapshot_does_not_keep_the_source_open(self, media: Path, tmp_path: Path):
        snapshot = create_snapshot(media, tmp_path / "snap.mp4")
        # A leaked read handle would block this rename on Windows and would keep
        # the inode alive on Linux after an owner deletes the original.
        renamed = media.with_suffix(".moved")
        os.rename(media, renamed)
        assert snapshot.path.exists()
