"""
Durable local job journal.

Postgres owns scheduling. This journal is a *recovery cache* and nothing more —
it answers "what had this machine already finished when it went down?" so a
restart does not re-encode a three-hour lecture because the completion response
was lost.

Four facts are worth persisting, and each maps to a specific failure the plan
enumerates:

- **completed renditions** — a partial encode restarts only the missing
  rendition, not the whole ladder;
- **package validation** — a validated package is not re-packaged;
- **transfer results** — a partial upload retries only the missing objects, and
  never re-encodes;
- **unacknowledged completion** — a completion whose response was lost is
  replayed idempotently, which the API accepts because the attempt either still
  owns the row (and is ignored as a duplicate) or no longer does (and is refused).

Storage is SQLite rather than JSON because a crash mid-write must not corrupt the
whole file, and it is local rather than in Postgres because the point is to
survive the network being gone.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS job (
  video_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  job_id TEXT NOT NULL DEFAULT '',
  source_sha256 TEXT,
  plan_fingerprint TEXT,
  snapshot_path TEXT,
  state TEXT NOT NULL DEFAULT 'started',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  PRIMARY KEY (video_id, attempt_id)
);

CREATE TABLE IF NOT EXISTS rendition (
  video_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  backend TEXT NOT NULL DEFAULT '',
  completed_at REAL NOT NULL,
  PRIMARY KEY (video_id, attempt_id, label)
);

CREATE TABLE IF NOT EXISTS artifact (
  video_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL DEFAULT '',
  uploaded_at REAL,
  verified_at REAL,
  PRIMARY KEY (video_id, attempt_id, path)
);

CREATE TABLE IF NOT EXISTS completion (
  video_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  PRIMARY KEY (video_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS completion_unacked_idx
  ON completion (acknowledged, created_at);
"""


@dataclass
class JournalJob:
    video_id: str
    attempt_id: str
    job_id: str
    source_sha256: str
    plan_fingerprint: str
    snapshot_path: str
    state: str


class RecoveryJournal:
    """Local, crash-safe record of in-progress and finished work."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._connection = sqlite3.connect(str(self.path), check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        # WAL keeps a reader (the daemon) from blocking the writer (a render
        # thread) and survives a power cut without losing committed rows.
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=NORMAL")
        with self._lock:
            self._connection.executescript(SCHEMA)
            self._connection.commit()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    # ── jobs ────────────────────────────────────────────────────────────────

    def start_job(
        self,
        video_id: str,
        attempt_id: str,
        *,
        job_id: str = "",
        source_sha256: str = "",
        plan_fingerprint: str = "",
        snapshot_path: str = "",
    ) -> None:
        now = time.time()
        self._execute(
            """
            INSERT INTO job (video_id, attempt_id, job_id, source_sha256, plan_fingerprint,
                             snapshot_path, state, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?)
            ON CONFLICT (video_id, attempt_id) DO UPDATE SET
              job_id = CASE WHEN excluded.job_id <> '' THEN excluded.job_id ELSE job.job_id END,
              source_sha256 = excluded.source_sha256,
              plan_fingerprint = excluded.plan_fingerprint,
              snapshot_path = excluded.snapshot_path,
              state = 'started',
              updated_at = excluded.updated_at
            """,
            (video_id, attempt_id, job_id, source_sha256, plan_fingerprint, snapshot_path, now, now),
        )

    def set_job_state(self, video_id: str, attempt_id: str, state: str) -> None:
        self._execute(
            "UPDATE job SET state = ?, updated_at = ? WHERE video_id = ? AND attempt_id = ?",
            (state, time.time(), video_id, attempt_id),
        )

    def get_job(self, video_id: str, attempt_id: str) -> Optional[JournalJob]:
        row = self._query_one(
            "SELECT * FROM job WHERE video_id = ? AND attempt_id = ?",
            (video_id, attempt_id),
        )
        if row is None:
            return None
        return JournalJob(
            video_id=row["video_id"],
            attempt_id=row["attempt_id"],
            job_id=row["job_id"] or "",
            source_sha256=row["source_sha256"] or "",
            plan_fingerprint=row["plan_fingerprint"] or "",
            snapshot_path=row["snapshot_path"] or "",
            state=row["state"],
        )

    def unfinished_jobs(self, limit: int = 50) -> List[JournalJob]:
        """
        Jobs that were interrupted.

        Excludes `completed` and `abandoned`, so a restart does not try to resume
        work that was already acknowledged or explicitly dropped.
        """
        rows = self._query_all(
            """
            SELECT * FROM job
            WHERE state NOT IN ('completed', 'abandoned')
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        )
        return [
            JournalJob(
                video_id=row["video_id"],
                attempt_id=row["attempt_id"],
                job_id=row["job_id"] or "",
                source_sha256=row["source_sha256"] or "",
                plan_fingerprint=row["plan_fingerprint"] or "",
                snapshot_path=row["snapshot_path"] or "",
                state=row["state"],
            )
            for row in rows
        ]

    # ── renditions ──────────────────────────────────────────────────────────

    def record_rendition(
        self,
        video_id: str,
        attempt_id: str,
        label: str,
        path: str,
        *,
        bytes_: int = 0,
        backend: str = "",
    ) -> None:
        self._execute(
            """
            INSERT INTO rendition (video_id, attempt_id, label, path, bytes, backend, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (video_id, attempt_id, label) DO UPDATE SET
              path = excluded.path, bytes = excluded.bytes,
              backend = excluded.backend, completed_at = excluded.completed_at
            """,
            (video_id, attempt_id, label, path, bytes_, backend, time.time()),
        )

    def reusable_across_attempts(
        self,
        video_id: str,
        source_sha256: str,
        plan_fingerprint: str,
    ) -> Dict[str, str]:
        """
        Encoded renditions for this video from **any** attempt.

        A retry gets a fresh attempt id from the server, so keying reuse on the
        attempt would mean the journal's contents were unreachable exactly when
        they are needed — which is why the resume path had no working caller.
        Reuse is bound to what actually determines the bytes: the source hash and
        the plan fingerprint. Same source, same ladder, byte-identical rendition.

        Later rows win, so a re-encode supersedes an older file.
        """
        rows = self._query_all(
            """
            SELECT r.label, r.path, r.completed_at
            FROM rendition AS r
            JOIN job AS j ON j.video_id = r.video_id AND j.attempt_id = r.attempt_id
            WHERE r.video_id = ?
              AND j.source_sha256 = ?
              AND j.plan_fingerprint = ?
            ORDER BY r.completed_at ASC
            """,
            (video_id, source_sha256, plan_fingerprint),
        )
        reusable: Dict[str, str] = {}
        for row in rows:
            path = Path(row["path"])
            if path.exists() and path.stat().st_size > 1000:
                reusable[row["label"]] = str(path)
        return reusable

    def reusable_renditions(
        self,
        video_id: str,
        attempt_id: str,
        source_sha256: str,
        plan_fingerprint: str,
    ) -> Dict[str, str]:
        """
        Renditions that may be reused for this attempt.

        Requires the journal to agree on both the source hash and the plan
        fingerprint: reuse across a changed ladder would mix renditions produced
        under two different rules, which is worse than re-encoding.
        """
        job = self.get_job(video_id, attempt_id)
        if not job:
            return {}
        if source_sha256 and job.source_sha256 and job.source_sha256 != source_sha256:
            return {}
        if plan_fingerprint and job.plan_fingerprint and job.plan_fingerprint != plan_fingerprint:
            return {}

        rows = self._query_all(
            "SELECT label, path FROM rendition WHERE video_id = ? AND attempt_id = ?",
            (video_id, attempt_id),
        )
        reusable: Dict[str, str] = {}
        for row in rows:
            path = Path(row["path"])
            # A journal entry whose file is gone is worse than no entry: it
            # would let the pipeline skip a rendition that does not exist.
            if path.exists() and path.stat().st_size > 1000:
                reusable[row["label"]] = str(path)
        return reusable

    # ── artifacts ───────────────────────────────────────────────────────────

    def record_artifact(
        self,
        video_id: str,
        attempt_id: str,
        path: str,
        *,
        size_bytes: int = 0,
        checksum: str = "",
        uploaded: bool = False,
        verified: bool = False,
    ) -> None:
        now = time.time()
        self._execute(
            """
            INSERT INTO artifact (video_id, attempt_id, path, size_bytes, checksum,
                                  uploaded_at, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (video_id, attempt_id, path) DO UPDATE SET
              size_bytes = excluded.size_bytes,
              checksum = CASE WHEN excluded.checksum <> '' THEN excluded.checksum ELSE artifact.checksum END,
              uploaded_at = COALESCE(excluded.uploaded_at, artifact.uploaded_at),
              verified_at = COALESCE(excluded.verified_at, artifact.verified_at)
            """,
            (
                video_id, attempt_id, path, size_bytes, checksum,
                now if uploaded else None,
                now if verified else None,
            ),
        )

    def verified_paths(self, video_id: str, attempt_id: str) -> set[str]:
        rows = self._query_all(
            "SELECT path FROM artifact WHERE video_id = ? AND attempt_id = ? AND verified_at IS NOT NULL",
            (video_id, attempt_id),
        )
        return {row["path"] for row in rows}

    def uploaded_paths(self, video_id: str, attempt_id: str) -> set[str]:
        rows = self._query_all(
            "SELECT path FROM artifact WHERE video_id = ? AND attempt_id = ? AND uploaded_at IS NOT NULL",
            (video_id, attempt_id),
        )
        return {row["path"] for row in rows}

    # ── completion replay ───────────────────────────────────────────────────

    def record_completion(self, video_id: str, attempt_id: str, payload: Dict[str, Any]) -> None:
        """
        Persist a completion *before* it is sent.

        Ordering matters: a crash between sending and recording means the
        completion is replayed, which the API tolerates (it is idempotent). The
        reverse order means a crash between recording and sending loses the
        completion altogether, and the job waits for its lease to expire.
        """
        now = time.time()
        self._execute(
            """
            INSERT INTO completion (video_id, attempt_id, payload, acknowledged, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)
            ON CONFLICT (video_id, attempt_id) DO UPDATE SET
              payload = excluded.payload, updated_at = excluded.updated_at
            """,
            (video_id, attempt_id, json.dumps(payload), now, now),
        )

    def acknowledge_completion(self, video_id: str, attempt_id: str) -> None:
        self._execute(
            "UPDATE completion SET acknowledged = 1, updated_at = ? WHERE video_id = ? AND attempt_id = ?",
            (time.time(), video_id, attempt_id),
        )

    def unacknowledged_completions(self, limit: int = 20) -> List[Dict[str, Any]]:
        rows = self._query_all(
            """
            SELECT video_id, attempt_id, payload FROM completion
            WHERE acknowledged = 0
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (limit,),
        )
        results = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except json.JSONDecodeError:
                continue
            results.append(
                {
                    "video_id": row["video_id"],
                    "attempt_id": row["attempt_id"],
                    "payload": payload,
                }
            )
        return results

    # ── maintenance ─────────────────────────────────────────────────────────

    def forget_job(self, video_id: str, attempt_id: str) -> None:
        """Drop a job's rows once the API has acknowledged completion."""
        for table in ("rendition", "artifact", "completion", "job"):
            self._execute(
                f"DELETE FROM {table} WHERE video_id = ? AND attempt_id = ?",  # noqa: S608 — fixed table list
                (video_id, attempt_id),
            )

    def fetch_snapshot_path(self, video_id: str, attempt_id: str) -> Optional[Path]:
        job = self.get_job(video_id, attempt_id)
        if not job or not job.snapshot_path:
            return None
        path = Path(job.snapshot_path)
        return path if path.exists() else None

    # ── sqlite plumbing ─────────────────────────────────────────────────────

    def _execute(self, sql: str, params: tuple) -> None:
        with self._lock:
            self._connection.execute(sql, params)
            self._connection.commit()

    def _query_all(self, sql: str, params: tuple) -> List[sqlite3.Row]:
        with self._lock:
            return list(self._connection.execute(sql, params).fetchall())

    def _query_one(self, sql: str, params: tuple) -> Optional[sqlite3.Row]:
        rows = self._query_all(sql, params)
        return rows[0] if rows else None
