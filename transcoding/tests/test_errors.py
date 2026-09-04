"""Tests for the typed error taxonomy."""
import pytest

from errors import (
    ERROR_TRANSCODE_FAILED,
    TranscodeError,
    classify_error,
)


class TestClassifyError:
    def test_transcode_error_passes_its_code_through(self):
        err = TranscodeError("EMPTY_FILE", "file too small")
        assert classify_error(err) == "EMPTY_FILE"

    def test_unknown_exceptions_map_to_generic_code(self):
        assert classify_error(ValueError("boom")) == ERROR_TRANSCODE_FAILED
        assert classify_error(RuntimeError("ffmpeg died")) == ERROR_TRANSCODE_FAILED

    def test_code_and_message_are_attached(self):
        err = TranscodeError("X", "message here")
        assert err.code == "X"
        assert err.message == "message here"
        assert str(err) == "message here"

    def test_raises_like_a_plain_exception(self):
        with pytest.raises(TranscodeError):
            raise TranscodeError("Y", "nope")
