"""Path policy: traversal, symlink escape, special files, browsing."""
import os
import stat
from pathlib import Path

import pytest

from openvod_transcoder.paths import (
    REASON_INVALID,
    REASON_NOT_A_FILE,
    REASON_NOT_A_DIRECTORY,
    REASON_NOT_FOUND,
    REASON_OUTSIDE_ROOTS,
    DirectoryListing,
    PathPolicy,
    PathRejected,
    Root,
    file_identity,
    guess_media_type,
)


@pytest.fixture()
def media_root(tmp_path: Path) -> Path:
    root = tmp_path / "media"
    (root / "course").mkdir(parents=True)
    (root / "course" / "lesson-01.mp4").write_bytes(b"a" * 100)
    (root / "course" / "lesson-02.mkv").write_bytes(b"b" * 200)
    (root / "course" / "notes.txt").write_text("hello")
    (root / ".hidden.mp4").write_bytes(b"c")
    return root


@pytest.fixture()
def policy(media_root: Path) -> PathPolicy:
    return PathPolicy([Root(name="media", path=media_root)])


class TestResolve:
    def test_accepts_a_file_inside_a_root(self, policy: PathPolicy, media_root: Path):
        resolved = policy.resolve(media_root / "course" / "lesson-01.mp4")
        assert resolved.name == "lesson-01.mp4"

    def test_rejects_traversal_out_of_the_root(self, policy: PathPolicy, media_root: Path):
        with pytest.raises(PathRejected) as caught:
            policy.resolve(media_root / ".." / ".." / "etc" / "passwd")
        assert caught.value.reason == REASON_OUTSIDE_ROOTS

    def test_rejects_an_absolute_path_outside_every_root(self, policy: PathPolicy):
        with pytest.raises(PathRejected) as caught:
            policy.resolve("/etc/passwd")
        assert caught.value.reason == REASON_OUTSIDE_ROOTS

    def test_rejects_a_symlink_pointing_outside_the_root(
        self, policy: PathPolicy, media_root: Path, tmp_path: Path
    ):
        secret = tmp_path / "secret.mp4"
        secret.write_bytes(b"top secret")
        link = media_root / "course" / "innocent.mp4"
        os.symlink(secret, link)
        with pytest.raises(PathRejected) as caught:
            policy.resolve(link)
        assert caught.value.reason == REASON_OUTSIDE_ROOTS

    def test_accepts_a_symlink_that_stays_inside_the_root(
        self, policy: PathPolicy, media_root: Path
    ):
        link = media_root / "alias.mp4"
        os.symlink(media_root / "course" / "lesson-01.mp4", link)
        assert policy.resolve(link).name == "lesson-01.mp4"

    def test_rejects_a_relative_path(self, policy: PathPolicy):
        with pytest.raises(PathRejected) as caught:
            policy.resolve("course/lesson-01.mp4")
        assert caught.value.reason == REASON_INVALID

    def test_rejects_an_empty_path(self, policy: PathPolicy):
        with pytest.raises(PathRejected) as caught:
            policy.resolve("")
        assert caught.value.reason == REASON_INVALID

    def test_rejects_a_nul_byte(self, policy: PathPolicy, media_root: Path):
        with pytest.raises(PathRejected) as caught:
            policy.resolve(f"{media_root}/a\x00b.mp4")
        assert caught.value.reason == REASON_INVALID

    def test_reports_a_missing_file_separately(self, policy: PathPolicy, media_root: Path):
        with pytest.raises(PathRejected) as caught:
            policy.resolve(media_root / "course" / "gone.mp4")
        assert caught.value.reason == REASON_NOT_FOUND

    @pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="POSIX only")
    def test_rejects_a_fifo(self, policy: PathPolicy, media_root: Path):
        # Opening a FIFO with no writer blocks forever, which would hang the job
        # rather than fail it.
        fifo = media_root / "course" / "pipe.mp4"
        os.mkfifo(fifo)
        with pytest.raises(PathRejected) as caught:
            policy.resolve(fifo)
        assert caught.value.reason == REASON_NOT_A_FILE

    def test_rejects_a_directory(self, policy: PathPolicy, media_root: Path):
        with pytest.raises(PathRejected) as caught:
            policy.resolve(media_root / "course")
        assert caught.value.reason == REASON_NOT_A_FILE

    def test_the_root_itself_is_not_importable_as_a_file(self, policy: PathPolicy, media_root: Path):
        with pytest.raises(PathRejected):
            policy.resolve(media_root)


class TestDisplayPath:
    def test_never_exposes_an_absolute_host_path(self, policy: PathPolicy, media_root: Path):
        resolved = policy.resolve(media_root / "course" / "lesson-01.mp4")
        assert policy.display_path(resolved) == "course/lesson-01.mp4"
        assert str(media_root) not in policy.display_path(resolved)


class TestFileIdentity:
    def test_identity_is_stable_for_an_unchanged_file(self, media_root: Path):
        path = media_root / "course" / "lesson-01.mp4"
        assert file_identity(path) == file_identity(path)

    def test_identity_carries_device_inode_size_and_mtime(self, media_root: Path):
        path = media_root / "course" / "lesson-01.mp4"
        info = path.stat()
        assert file_identity(path) == (
            f"{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}"
        )


class TestListDirectory:
    def test_lists_files_and_directories_without_host_paths(
        self, policy: PathPolicy, media_root: Path
    ):
        listing = policy.list_directory(media_root)
        assert isinstance(listing, DirectoryListing)
        assert listing.root == "media"
        assert listing.path == "."
        names = [entry.name for entry in listing.entries]
        assert names == ["course"]
        assert all(str(media_root) not in entry.path for entry in listing.entries)

    def test_hidden_entries_are_omitted_by_default(self, policy: PathPolicy, media_root: Path):
        listing = policy.list_directory(media_root)
        assert ".hidden.mp4" not in [entry.name for entry in listing.entries]

    def test_hidden_entries_can_be_requested(self, policy: PathPolicy, media_root: Path):
        listing = policy.list_directory(media_root, include_hidden=True)
        assert ".hidden.mp4" in [entry.name for entry in listing.entries]

    def test_media_files_are_marked_and_others_are_not(
        self, policy: PathPolicy, media_root: Path
    ):
        listing = policy.list_directory(media_root / "course")
        kinds = {entry.name: entry.media_type for entry in listing.entries}
        assert kinds["lesson-01.mp4"] == "video"
        assert kinds["lesson-02.mkv"] == "video"
        assert kinds["notes.txt"] == ""

    def test_sizes_and_identity_are_reported_for_files(
        self, policy: PathPolicy, media_root: Path
    ):
        listing = policy.list_directory(media_root / "course")
        lesson = next(entry for entry in listing.entries if entry.name == "lesson-01.mp4")
        assert lesson.size == 100
        assert lesson.identity
        assert lesson.is_directory is False

    def test_pagination_returns_a_cursor_that_resumes(
        self, policy: PathPolicy, media_root: Path
    ):
        first = policy.list_directory(media_root / "course", limit=2)
        assert len(first.entries) == 2
        assert first.next_cursor == first.entries[-1].name
        second = policy.list_directory(media_root / "course", limit=2, cursor=first.next_cursor)
        assert second.next_cursor == ""
        assert [entry.name for entry in second.entries] == ["notes.txt"]

    def test_symlinks_escaping_the_root_are_not_listed_at_all(
        self, policy: PathPolicy, media_root: Path, tmp_path: Path
    ):
        secret = tmp_path / "secret.mp4"
        secret.write_bytes(b"x")
        os.symlink(secret, media_root / "course" / "escape.mp4")
        listing = policy.list_directory(media_root / "course")
        assert "escape.mp4" not in [entry.name for entry in listing.entries]

    def test_directory_that_escapes_is_refused(self, policy: PathPolicy, tmp_path: Path):
        outside = tmp_path / "elsewhere"
        outside.mkdir()
        with pytest.raises(PathRejected) as caught:
            policy.list_directory(outside)
        assert caught.value.reason == REASON_OUTSIDE_ROOTS

    def test_listing_a_file_is_refused(self, policy: PathPolicy, media_root: Path):
        with pytest.raises(PathRejected) as caught:
            policy.list_directory(media_root / "course" / "lesson-01.mp4")
        assert caught.value.reason == REASON_NOT_A_DIRECTORY


class TestMultipleRoots:
    def test_a_path_is_accepted_from_any_configured_root(self, tmp_path: Path):
        first = tmp_path / "one"
        second = tmp_path / "two"
        first.mkdir()
        second.mkdir()
        (second / "clip.mp4").write_bytes(b"z")
        policy = PathPolicy([Root("one", first), Root("two", second)])
        assert policy.resolve(second / "clip.mp4").name == "clip.mp4"
        assert policy.root_named("two").path == second

    def test_paths_are_reported_relative_to_their_own_root(self, tmp_path: Path):
        first = tmp_path / "one"
        second = tmp_path / "two"
        (second / "nested").mkdir(parents=True)
        (second / "nested" / "clip.mp4").write_bytes(b"z")
        policy = PathPolicy([Root("one", first), Root("two", second)])
        resolved = policy.resolve(second / "nested" / "clip.mp4")
        assert policy.display_path(resolved) == "nested/clip.mp4"
        assert policy.root_for(resolved) == "two"

    def test_at_least_one_root_is_required(self):
        with pytest.raises(ValueError):
            PathPolicy([])


class TestMediaType:
    def test_video_and_audio_are_distinguished(self):
        assert guess_media_type("a.mp4") == "video"
        assert guess_media_type("a.mkv") == "video"
        assert guess_media_type("a.mp3") == "audio"
        assert guess_media_type("a.flac") == "audio"

    def test_unknown_extensions_are_not_offered(self):
        assert guess_media_type("a.txt") == ""
        assert guess_media_type("README") == ""


class TestDirectoryEntryPayload:
    def test_entry_payload_uses_the_wire_vocabulary(self, policy: PathPolicy, media_root: Path):
        listing = policy.list_directory(media_root / "course")
        payload = listing.entries[0].as_payload()
        assert set(payload) == {
            "name", "path", "isDirectory", "size", "modifiedAt", "mediaType", "identity",
        }
        assert payload["isDirectory"] is False


class TestSpecialFileModes:
    def test_a_character_device_is_refused(self, policy: PathPolicy, media_root: Path):
        device = media_root / "urandom.mp4"
        try:
            os.symlink("/dev/urandom", device)
        except OSError:
            pytest.skip("cannot symlink on this platform")
        with pytest.raises(PathRejected) as caught:
            policy.resolve(device)
        assert caught.value.reason == REASON_OUTSIDE_ROOTS

    def test_lstat_mode_check_covers_block_devices(self):
        # The policy uses stat.S_ISREG, which is false for both block and
        # character devices; this asserts the constant we depend on.
        assert stat.S_ISREG(stat.S_IFREG | 0o644) is True
        assert stat.S_ISREG(stat.S_IFBLK | 0o660) is False
        assert stat.S_ISREG(stat.S_IFCHR | 0o660) is False
