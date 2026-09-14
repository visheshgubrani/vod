"""Tests for heartbeat/callback network behavior (no real network)."""
import requests

from openvod_transcoder.utils import network as netw


class FakeResponse:
    def __init__(self, status_code=200, text=""):
        self.status_code = status_code
        self.text = text

    @property
    def ok(self):
        return 200 <= self.status_code < 300

    def raise_for_status(self):
        if not self.ok:
            from requests import HTTPError

            err = HTTPError(f"HTTP {self.status_code}")
            err.response = type(
                "R", (), {"status_code": self.status_code, "text": self.text}
            )()
            raise err


def _make_posts(monkeypatch, results):
    calls = []
    fake = FakeResponse(200)

    def post(url, **kwargs):
        calls.append((url, kwargs))
        result = results.pop(0) if results else fake
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(netw.requests, "post", post)
    return calls


class TestSendHeartbeatNonFatal:
    def test_successful_heartbeat_posts_json(self, monkeypatch):
        calls = _make_posts(monkeypatch, [FakeResponse(200)])
        monkeypatch.setattr(netw.time, "sleep", lambda s: None)

        # localhost is always allowed as a callback target
        netw.send_heartbeat("http://localhost:8787/api/webhook/heartbeat", "v1", "transcode", 0.5)

        assert len(calls) == 1
        body = calls[0][1]["json"]
        assert body["video_id"] == "v1"
        assert body["stage"] == "transcode"
        assert body["progress"] == 0.5

    def test_network_errors_are_swallowed_never_raise(self, monkeypatch):
        calls = _make_posts(monkeypatch, [ConnectionError("boom"), ConnectionError("boom")])
        monkeypatch.setattr(netw.time, "sleep", lambda s: None)

        # must not raise despite two failed attempts
        netw.send_heartbeat("http://localhost:8787/api/webhook/heartbeat", "v1", "x", 0.1)

        assert len(calls) == 2  # bounded attempts, no infinite retry

    def test_blocked_url_never_posts(self, monkeypatch):
        calls = _make_posts(monkeypatch, [FakeResponse(200)])
        monkeypatch.setattr(netw.time, "sleep", lambda s: None)

        # https non-localhost with an empty allowlist is blocked by policy
        netw.send_heartbeat("https://api.example.com/hb", "v1", "x", 0.1)

        assert calls == []


class TestSendCallbackRetryPolicy:
    def test_success_on_first_attempt(self, monkeypatch):
        calls = _make_posts(monkeypatch, [FakeResponse(200)])
        monkeypatch.setattr(netw.time, "sleep", lambda s: None)
        netw.send_callback("http://localhost:8787/api/webhook/transcode-complete", {"status": "success"})
        assert len(calls) == 1

    def test_client_rejection_is_not_retried(self, monkeypatch):
        calls = _make_posts(monkeypatch, [FakeResponse(401)])
        monkeypatch.setattr(netw.time, "sleep", lambda s: None)
        netw.send_callback("http://localhost:8787/api/webhook/transcode-complete", {})
        assert len(calls) == 1

    def test_server_errors_are_retried_then_dropped(self, monkeypatch):
        calls = _make_posts(monkeypatch, [FakeResponse(503), FakeResponse(503), FakeResponse(503)])
        monkeypatch.setattr(netw.time, "sleep", lambda s: None)
        netw.send_callback("http://localhost:8787/api/webhook/transcode-complete", {})
        assert len(calls) == 3  # max_retries attempts, then give up quietly

    def test_a_retried_attempt_says_why(self, monkeypatch, capsys):
        # The failure that prompted this: every attempt logged "failed" and
        # nothing else, while the response body carried the answer.
        _make_posts(
            monkeypatch,
            [
                FakeResponse(530, "error code: 1033")
                for _ in range(3)
            ],
        )
        monkeypatch.setattr(netw.time, "sleep", lambda s: None)

        netw.send_callback("http://localhost:8787/api/webhook/transcode-complete", {})

        out = capsys.readouterr().out
        assert "530" in out
        assert "1033" in out


class TestCallbackFailureReason:
    """One line, and it has to name the cause."""

    def _http_error(self, status_code, text=""):
        err = requests.HTTPError(f"HTTP {status_code}")
        err.response = FakeResponse(status_code, text)
        return err

    def test_names_the_status_and_the_response_body(self):
        reason = netw.callback_failure_reason(self._http_error(530, "error code: 1033"))

        assert reason == "HTTP 530: error code: 1033"

    def test_collapses_and_truncates_a_multiline_body(self):
        html = "<html>\n  <head>\n    <title>530</title>\n  </head>\n</html>"

        reason = netw.callback_failure_reason(self._http_error(530, html), limit=40)

        assert len(reason) <= len("HTTP 530: ") + 40
        assert "\n" not in reason

    def test_survives_an_error_with_no_response(self):
        assert netw.callback_failure_reason(requests.HTTPError("boom")) == "HTTPError: boom"

    def test_names_network_exceptions(self):
        assert netw.callback_failure_reason(ConnectionError("refused")) == (
            "ConnectionError: refused"
        )
