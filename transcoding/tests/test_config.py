"""Allowlists are read from the current env, not an import-time snapshot."""

from openvod_transcoder.config import (
    allowed_callback_hosts,
    allowed_source_buckets,
    allowed_url_hosts,
    config_warnings,
)


class TestAllowedSourceBuckets:
    def test_parses_the_raw_bucket_literal(self):
        assert allowed_source_buckets({"ALLOWED_SOURCE_BUCKETS": "openvod-raw"}) == {
            "openvod-raw"
        }

    def test_empty_or_missing_is_an_empty_set(self):
        assert allowed_source_buckets({"ALLOWED_SOURCE_BUCKETS": ""}) == frozenset()
        assert allowed_source_buckets({}) == frozenset()
        assert allowed_source_buckets({"ALLOWED_SOURCE_BUCKETS": "  ,  "}) == frozenset()

    def test_splits_commas_and_lowercases(self):
        assert allowed_source_buckets(
            {"ALLOWED_SOURCE_BUCKETS": " openvod-raw , Other-Bucket "}
        ) == {"openvod-raw", "other-bucket"}


class TestAllowedCallbackAndUrlHosts:
    def test_callback_hosts_parse_localhost_literal(self):
        assert allowed_callback_hosts({"ALLOWED_CALLBACK_HOSTS": "localhost"}) == {
            "localhost"
        }

    def test_url_hosts_empty_when_unset(self):
        assert allowed_url_hosts({}) == frozenset()


class TestConfigWarnings:
    def test_mentions_both_keys_when_unset(self):
        messages = config_warnings({})
        assert any("ALLOWED_SOURCE_BUCKETS" in message for message in messages)
        assert any("ALLOWED_CALLBACK_HOSTS" in message for message in messages)

    def test_silent_when_both_are_set(self):
        assert (
            config_warnings(
                {
                    "ALLOWED_SOURCE_BUCKETS": "openvod-raw",
                    "ALLOWED_CALLBACK_HOSTS": "localhost",
                }
            )
            == []
        )
