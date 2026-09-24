"""
The agent's API client.

Every call the agent makes goes through here, which is what makes the security
properties structural rather than aspirational:

- **One credential, one scope.** The deployment secret is attached here and nowhere else; the
  agent never reads R2 credentials, and there is no code path in which it could.
- **Bounded retries with honest outcomes.** A network error is retried with
  backoff; a 4xx is not, because a request the server refused will be refused
  again. `LeaseLost` is raised distinctly so the runner can stop work *before*
  the lease expires instead of uploading into a prefix it no longer owns.
- **No unbounded blocking.** Every request has a timeout, so a hung server cannot
  wedge a machine the owner is also using.
"""
from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

DEFAULT_TIMEOUT = 30.0
DEFAULT_ATTEMPTS = 3


class AgentApiError(Exception):
    """A typed failure from the API, carrying the server's code when it has one."""

    def __init__(self, status: int, message: str, code: str = "", body: Any = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message
        self.code = code
        self.body = body

    @property
    def retryable(self) -> bool:
        return self.status >= 500 or self.status == 429


class LeaseLost(AgentApiError):
    """
    The attempt no longer owns its job.

    Raised rather than returned because continuing is never correct: the work
    produced so far may already have been superseded, and uploading or completing
    under another attempt's ownership is the exact race attempt ownership exists
    to prevent.
    """


class AuthenticationFailed(AgentApiError):
    """The credential was rejected. Retrying will not help; the owner must act."""


@dataclass
class ApiConfig:
    base_url: str
    secret: str
    timeout: float = DEFAULT_TIMEOUT
    attempts: int = DEFAULT_ATTEMPTS
    user_agent: str = "clipmux-transcoder"


class TranscoderApiClient:
    """Thin, typed wrapper over `/api/transcoder/v1`."""

    def __init__(self, config: ApiConfig, session=None):
        self.config = config
        self._session = session

    @property
    def session(self):
        if self._session is None:
            import requests

            self._session = requests.Session()
            self._session.headers.update(
                {
                    "x-local-transcoder-secret": self.config.secret,
                    "Content-Type": "application/json",
                    "User-Agent": self.config.user_agent,
                }
            )
        return self._session

    # ── transport ───────────────────────────────────────────────────────────

    def _url(self, path: str) -> str:
        return f"{self.config.base_url.rstrip('/')}/api/transcoder/v1/{path.lstrip('/')}"

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> Any:
        import requests

        url = self._url(path)
        last_error: Optional[Exception] = None

        for attempt in range(max(1, self.config.attempts)):
            try:
                response = self.session.request(
                    method,
                    url,
                    json=json_body,
                    timeout=timeout or self.config.timeout,
                )
            except requests.RequestException as exc:
                last_error = exc
                if attempt == self.config.attempts - 1:
                    raise AgentApiError(0, f"network error: {exc}") from exc
                time.sleep(_backoff(attempt))
                continue

            if response.status_code < 400:
                if not response.content:
                    return None
                try:
                    return response.json()
                except ValueError:
                    return None

            body: Any = None
            try:
                body = response.json()
            except ValueError:
                body = response.text[:500]

            message = body.get("error") if isinstance(body, dict) else str(body)
            code = body.get("code", "") if isinstance(body, dict) else ""

            error = _error_for(response.status_code, message or "request failed", code, body)

            # 401/403 mean the credential is wrong or revoked: retrying is noise.
            # 409 means the attempt lost ownership: stop, do not retry.
            if isinstance(error, (LeaseLost, AuthenticationFailed)):
                raise error
            if not error.retryable or attempt == self.config.attempts - 1:
                raise error

            time.sleep(_backoff(attempt))

        raise AgentApiError(0, f"request failed: {last_error}")

    # ── protocol ────────────────────────────────────────────────────────────

    def status(self) -> Dict[str, Any]:
        """Read worker configuration without changing its liveness timestamp."""
        result = self._request("GET", "config")
        return result if isinstance(result, dict) else {}

    def heartbeat(
        self,
        *,
        capabilities: Optional[Dict[str, Any]] = None,
        progress: Optional[Dict[str, Any]] = None,
        hostname: str = "",
        worker_version: str = "",
        capacity_jobs: Optional[int] = None,
        capacity_renditions: Optional[int] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if capabilities is not None:
            body["capabilities"] = capabilities
        if progress is not None:
            body["progress"] = progress
        if hostname:
            body["hostname"] = hostname
        if worker_version:
            body["workerVersion"] = worker_version
        if capacity_jobs is not None:
            body["capacityJobs"] = capacity_jobs
        if capacity_renditions is not None:
            body["capacityRenditions"] = capacity_renditions
        return self._request("POST", "heartbeat", json_body=body)

    def poll(self) -> Dict[str, Any]:
        result = self._request("GET", "poll")
        return result if isinstance(result, dict) else {"controls": [], "outstanding": {}}

    def answer_control(
        self, control_id: str, *, response: Optional[Dict[str, Any]] = None, error: str = ""
    ) -> Dict[str, Any]:
        return self._request(
            "POST",
            f"control/{control_id}",
            json_body={"ok": not error, "response": response, "error": error or None},
        )

    def claim(self, *, job_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        result = self._request("POST", "claim", json_body={"jobId": job_id} if job_id else {})
        return (result or {}).get("claim")

    def reconcile(self, attempts: List[Dict[str, str]]) -> Dict[str, Any]:
        return self._request("POST", "reconcile", json_body={"attempts": attempts})

    def register_source(
        self,
        *,
        root_name: str,
        relative_path: str,
        file_name: str,
        identity: str,
        size_bytes: Optional[int],
    ) -> Dict[str, Any]:
        return self._request(
            "POST",
            "sources",
            json_body={
                "rootName": root_name,
                "relativePath": relative_path,
                "fileName": file_name,
                "identity": identity,
                "sizeBytes": size_bytes,
            },
        )

    def source_grant(self, source_id: str, job_id: str, attempt_id: str) -> Dict[str, Any]:
        return self._request(
            "POST", f"sources/{source_id}/grant",
            json_body={"jobId": job_id, "attemptId": attempt_id},
        )

    def register_inventory(
        self, job_id: str, artifacts: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        return self._request(
            "POST", f"jobs/{job_id}/inventory", json_body={"artifacts": artifacts}
        )

    def artifact_grants(self, inventory_id: str, limit: int = 0) -> Dict[str, Any]:
        """One bounded page of upload grants, ordered segments-first."""
        body = {"limit": limit} if limit else {}
        return self._request("POST", f"inventories/{inventory_id}/grants", json_body=body)

    def mark_uploaded(
        self,
        inventory_id: str,
        paths: List[str],
        checksums: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        return self._request(
            "POST",
            f"inventories/{inventory_id}/uploaded",
            json_body={"paths": paths, "checksums": checksums or {}},
        )

    def verify_inventory(self, inventory_id: str, limit: int = 0) -> Dict[str, Any]:
        """One bounded verification batch; `remaining` says whether to ask again."""
        body = {"limit": limit} if limit else {}
        return self._request("POST", f"inventories/{inventory_id}/verify", json_body=body)

    def resume(self, job_id: str, attempt_id: str) -> Optional[Dict[str, Any]]:
        """
        Re-acquire an attempt this agent already owns, after a restart.

        Distinct from `claim`: claiming looks for *new* work, and a job this
        agent already holds is not queued, so claiming it is impossible. Reporting
        that an attempt may be resumed and then being unable to resume it is what
        left restarted agents idling until the lease expired.
        """
        result = self._request(
            "POST", f"jobs/{job_id}/resume", json_body={"attemptId": attempt_id}
        )
        return (result or {}).get("claim")

    def complete(self, job_id: str, attempt_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request(
            "POST",
            f"jobs/{job_id}/complete",
            json_body={"attemptId": attempt_id, "payload": payload},
        )

    def fail(
        self,
        job_id: str,
        attempt_id: str,
        *,
        message: str,
        error_code: str = "TRANSCODE_FAILED",
    ) -> Dict[str, Any]:
        return self._request(
            "POST",
            f"jobs/{job_id}/fail",
            json_body={"attemptId": attempt_id, "message": message, "errorCode": error_code},
        )


def _error_for(status: int, message: str, code: str, body: Any) -> AgentApiError:
    """
    Map a status onto the exception the caller must handle differently.

    `409` is ambiguous by design: the API uses it for both "attempt superseded"
    and "inventory not verified". Only the former is fatal for the attempt — the
    latter is a normal state the runner resolves by verifying. The server's error
    *code* disambiguates, so it is read rather than guessed from the status.
    """
    if status in (401, 403):
        return AuthenticationFailed(status, message, code, body)
    if status == 409 and code in ("SUPERSEDED", "ATTEMPT_SUPERSEDED"):
        return LeaseLost(status, message, code, body)
    if status == 409 and code == "INVENTORY_UNVERIFIED":
        return AgentApiError(status, message, code, body)
    return AgentApiError(status, message, code, body)


def _backoff(attempt: int) -> float:
    return (2 ** attempt) + random.uniform(0, 0.5)


def _safe_json(response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None
