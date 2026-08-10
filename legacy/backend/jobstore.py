from __future__ import annotations

"""
In-process job store.

Replaces the previous Redis-backed state layer. All job metadata, per-item
results, and error lists live in module-level dictionaries guarded by a single
reentrant lock, so the API threads and the worker threads inside the same
process share one consistent view.

Trade-offs of this design (deliberate, see README):
- State is lost when the process restarts; in-flight jobs do not survive.
- Only ONE process may serve the app. Running multiple workers/instances would
  give each its own store and progress polling would hit the wrong one.
"""

import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "604800"))
_SWEEP_INTERVAL_SECONDS = int(os.getenv("JOB_SWEEP_INTERVAL_SECONDS", "300"))

# A reentrant lock: some helpers call others while already holding it.
_LOCK = threading.RLock()

# job_id -> {"meta": {...}, "results": {index: row}, "errors": [entry, ...],
#            "expires_at": float}
_JOBS: dict[str, dict[str, Any]] = {}

# Serializes live result.csv rewrites, mirroring the old Redis lock.
_CSV_LOCKS: dict[str, threading.Lock] = {}

_SWEEPER_STARTED = False


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _touch(job_id: str) -> None:
    """Extend a job's lifetime. Caller must hold _LOCK."""
    record = _JOBS.get(job_id)
    if record is not None:
        record["expires_at"] = time.time() + JOB_TTL_SECONDS


def _sweep_expired_jobs() -> int:
    """Drop jobs past their TTL. Replaces Redis key expiry."""
    removed = 0
    now = time.time()
    with _LOCK:
        for job_id in [
            job_id
            for job_id, record in _JOBS.items()
            if record.get("expires_at", 0) <= now
        ]:
            _JOBS.pop(job_id, None)
            _CSV_LOCKS.pop(job_id, None)
            removed += 1
    return removed


def start_sweeper() -> None:
    """Start the background TTL sweeper exactly once per process."""
    global _SWEEPER_STARTED
    with _LOCK:
        if _SWEEPER_STARTED:
            return
        _SWEEPER_STARTED = True

    def _loop() -> None:
        while True:
            time.sleep(_SWEEP_INTERVAL_SECONDS)
            try:
                _sweep_expired_jobs()
            except Exception:  # never let the sweeper thread die
                pass

    threading.Thread(target=_loop, name="job-ttl-sweeper", daemon=True).start()


def initialize_job_meta(job_id: str, total: int) -> None:
    now = utcnow_iso()
    with _LOCK:
        _JOBS[job_id] = {
            "meta": {
                "job_id": job_id,
                "status": "queued",
                "total": total,
                "processed": 0,
                "succeeded": 0,
                "failed": 0,
                "created_at": now,
                "updated_at": now,
            },
            "results": {},
            "errors": [],
            "expires_at": time.time() + JOB_TTL_SECONDS,
        }


def update_job_meta(job_id: str, updates: dict[str, Any]) -> None:
    with _LOCK:
        record = _JOBS.get(job_id)
        if record is None:
            return
        for key, value in updates.items():
            record["meta"][key] = "" if value is None else value
        record["meta"]["updated_at"] = utcnow_iso()
        _touch(job_id)


def increment_job_progress(job_id: str, success: bool) -> None:
    with _LOCK:
        record = _JOBS.get(job_id)
        if record is None:
            return
        meta = record["meta"]
        meta["processed"] = int(meta.get("processed", 0)) + 1
        counter = "succeeded" if success else "failed"
        meta[counter] = int(meta.get(counter, 0)) + 1
        meta["updated_at"] = utcnow_iso()
        _touch(job_id)


def get_job_meta(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        record = _JOBS.get(job_id)
        if record is None:
            return None

        result = dict(record["meta"])
        for key in ("total", "processed", "succeeded", "failed"):
            try:
                result[key] = int(result.get(key, 0))
            except (TypeError, ValueError):
                result[key] = 0
        return result


def append_job_error(job_id: str, input_image: str, error_message: str) -> None:
    entry = {
        "input_image": input_image,
        "error_message": error_message,
        "timestamp": utcnow_iso(),
    }
    with _LOCK:
        record = _JOBS.get(job_id)
        if record is None:
            return
        record["errors"].append(entry)
        _touch(job_id)


def read_job_errors(job_id: str, limit: int = 50) -> tuple[list[dict[str, Any]], int]:
    with _LOCK:
        record = _JOBS.get(job_id)
        if record is None:
            return [], 0

        errors = record["errors"]
        total = len(errors)
        if total <= 0:
            return [], 0
        if limit <= 0:
            return [], total
        return [dict(entry) for entry in errors[-limit:]], total


def store_job_result(job_id: str, row: dict[str, Any]) -> None:
    index = int(row.get("index", 0))
    with _LOCK:
        record = _JOBS.get(job_id)
        if record is None:
            return
        record["results"][index] = dict(row)
        _touch(job_id)


def read_job_results(
    job_id: str, limit: int | None = 50
) -> tuple[list[dict[str, Any]], int]:
    with _LOCK:
        record = _JOBS.get(job_id)
        if record is None:
            return [], 0

        parsed = [dict(row) for _, row in sorted(record["results"].items())]

    total = len(parsed)
    if limit is None or limit < 0:
        return parsed, total
    if limit == 0:
        return [], total
    return parsed[-limit:], total


def get_csv_lock(job_id: str) -> threading.Lock:
    """Per-job lock serializing live result.csv writes across worker threads."""
    with _LOCK:
        lock = _CSV_LOCKS.get(job_id)
        if lock is None:
            lock = threading.Lock()
            _CSV_LOCKS[job_id] = lock
        return lock


def job_exists(job_id: str) -> bool:
    with _LOCK:
        return job_id in _JOBS
