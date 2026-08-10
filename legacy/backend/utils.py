from __future__ import annotations

import csv
import io
import json
import logging
import os
import random
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import requests

from backend.config import load_environment
from backend.jobstore import (
    append_job_error,
    get_csv_lock,
    get_job_meta,
    increment_job_progress,
    initialize_job_meta,
    read_job_errors,
    read_job_results,
    start_sweeper,
    store_job_result,
    update_job_meta,
    utcnow_iso,
)

load_environment()

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent

# Storage root is configurable so a cloud deployment can point it at a mounted
# disk (e.g. APP_STORAGE_DIR=/data) instead of the source tree.
_STORAGE_ROOT_ENV = os.getenv("APP_STORAGE_DIR", "").strip()
STORAGE_DIR = Path(_STORAGE_ROOT_ENV).resolve() if _STORAGE_ROOT_ENV else BASE_DIR / "storage"
JOBS_DIR = STORAGE_DIR / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)

_ARCHIVE_DIR_ENV = os.getenv("ARCHIVE_RESULTS_DIR", "").strip()
ARCHIVE_RESULTS_DIR = (
    Path(_ARCHIVE_DIR_ENV).resolve() if _ARCHIVE_DIR_ENV else PROJECT_ROOT / "vector_images"
)
ARCHIVE_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

DOWNLOAD_TIMEOUT_SECONDS = int(os.getenv("DOWNLOAD_TIMEOUT_SECONDS", "30"))
MAX_DOWNLOAD_BYTES = int(os.getenv("MAX_DOWNLOAD_BYTES", str(20 * 1024 * 1024)))

_FILENAME_SANITIZE_RE = re.compile(r"[^A-Za-z0-9._-]+")

# Re-exported so existing imports (`from backend.utils import ...`) keep working.
__all__ = [
    "append_job_error",
    "build_result_csv_rows",
    "configure_logging",
    "decode_csv_bytes",
    "download_image_bytes",
    "ensure_job_dirs",
    "get_job_meta",
    "increment_job_progress",
    "initialize_job_meta",
    "is_valid_url",
    "load_job_manifest",
    "parse_input_links_csv",
    "parse_urls_text",
    "read_job_errors",
    "read_job_results",
    "refresh_live_result_csv",
    "retry_with_backoff",
    "sanitize_filename",
    "save_job_manifest",
    "start_sweeper",
    "store_job_result",
    "update_job_meta",
    "utcnow_iso",
    "write_archived_result_csv",
    "write_result_csv",
    "write_result_json",
]


class JsonFormatter(logging.Formatter):
    """Structured JSON logs for easier filtering and ingestion."""

    _reserved = {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "thread",
        "threadName",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key in self._reserved:
                continue
            payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=True)


def configure_logging() -> None:
    root_logger = logging.getLogger()
    if getattr(root_logger, "_json_logging_configured", False):
        return

    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())

    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    root_logger._json_logging_configured = True  # type: ignore[attr-defined]


def ensure_job_dirs(job_id: str) -> tuple[Path, Path]:
    job_dir = JOBS_DIR / job_id
    inputs_dir = job_dir / "inputs"
    job_dir.mkdir(parents=True, exist_ok=True)
    inputs_dir.mkdir(parents=True, exist_ok=True)
    return job_dir, inputs_dir


def save_job_manifest(job_id: str, items: list[dict[str, Any]]) -> Path:
    job_dir, _ = ensure_job_dirs(job_id)
    manifest_path = job_dir / "manifest.json"
    manifest_path.write_text(json.dumps(items, ensure_ascii=True), encoding="utf-8")
    return manifest_path


def load_job_manifest(job_id: str) -> list[dict[str, Any]]:
    manifest_path = JOBS_DIR / job_id / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Manifest not found for job {job_id}")
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def write_result_csv(job_id: str, rows: list[dict[str, str]]) -> Path:
    job_dir, _ = ensure_job_dirs(job_id)
    csv_path = job_dir / "result.csv"

    with csv_path.open("w", encoding="utf-8", newline="") as output_file:
        writer = csv.writer(output_file)
        writer.writerow(["input_image", "generated_image"])
        for row in rows:
            writer.writerow([row.get("input_image", ""), row.get("generated_image", "")])

    return csv_path


def write_archived_result_csv(job_id: str, rows: list[dict[str, str]]) -> Path:
    """
    Persist a timestamped copy of each completed job CSV in project-root/vector_images.
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_job_fragment = sanitize_filename(job_id)[:12]
    archive_name = f"result_{timestamp}_{safe_job_fragment}.csv"
    archive_path = ARCHIVE_RESULTS_DIR / archive_name

    with archive_path.open("w", encoding="utf-8", newline="") as output_file:
        writer = csv.writer(output_file)
        writer.writerow(["input_image", "generated_image"])
        for row in rows:
            writer.writerow([row.get("input_image", ""), row.get("generated_image", "")])

    return archive_path


def write_result_json(job_id: str, payload: list[dict[str, Any]]) -> Path:
    job_dir, _ = ensure_job_dirs(job_id)
    json_path = job_dir / "result.json"
    json_path.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
    return json_path


def build_result_csv_rows(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    csv_rows: list[dict[str, str]] = []
    for row in rows:
        csv_rows.append(
            {
                "input_image": str(row.get("input_image", "")),
                "generated_image": str(row.get("generated_image", "")) if row.get("status") == "success" else "",
            }
        )
    return csv_rows


def refresh_live_result_csv(job_id: str) -> Path:
    """
    Rewrite the job's live result.csv from current in-memory results.

    Serialized per job so concurrent worker threads cannot interleave writes
    to the same file.
    """
    lock = get_csv_lock(job_id)
    acquired = lock.acquire(timeout=15)
    if not acquired:
        raise RuntimeError("Could not acquire live result CSV lock")
    try:
        rows, _ = read_job_results(job_id, limit=None)
        return write_result_csv(job_id, build_result_csv_rows(rows))
    finally:
        lock.release()


def is_valid_url(value: str) -> bool:
    candidate = value.strip()
    if not candidate:
        return False

    try:
        parsed = urlparse(candidate)
    except ValueError:
        return False

    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def parse_urls_text(urls_text: str) -> list[str]:
    urls: list[str] = []
    for line in urls_text.splitlines():
        candidate = line.strip()
        if candidate:
            urls.append(candidate)
    return urls


def decode_csv_bytes(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("Unable to decode CSV file. Use UTF-8 or UTF-8 with BOM.")


def parse_input_links_csv(csv_bytes: bytes) -> list[str]:
    csv_text = decode_csv_bytes(csv_bytes)
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    if not rows:
        return []

    first_row = [cell.strip() for cell in rows[0]]
    header_lookup = {value.lower(): index for index, value in enumerate(first_row) if value}
    links: list[str] = []

    if "input_image_url" in header_lookup:
        url_index = header_lookup["input_image_url"]
        for row in rows[1:]:
            if url_index >= len(row):
                continue
            value = row[url_index].strip()
            if value:
                links.append(value)
        return links

    first_value = first_row[0] if first_row else ""
    start_index = 0 if is_valid_url(first_value) else 1

    for row in rows[start_index:]:
        if not row:
            continue
        value = row[0].strip()
        if value:
            links.append(value)

    return links


def sanitize_filename(filename: str, fallback: str = "input_image") -> str:
    candidate = Path(filename).name.strip()
    if not candidate:
        return fallback

    sanitized = _FILENAME_SANITIZE_RE.sub("_", candidate)
    sanitized = sanitized.strip("._")
    if not sanitized:
        sanitized = fallback

    return sanitized[:180]


def retry_with_backoff(
    operation: Callable[[], Any],
    *,
    retriable_exceptions: tuple[type[BaseException], ...],
    max_attempts: int = 5,
    base_delay_seconds: float = 1.0,
    max_delay_seconds: float = 30.0,
    jitter_seconds: float = 0.25,
    logger: logging.Logger | None = None,
    operation_name: str = "operation",
) -> Any:
    last_error: BaseException | None = None

    for attempt in range(1, max_attempts + 1):
        try:
            return operation()
        except retriable_exceptions as error:
            last_error = error
            if attempt == max_attempts:
                break

            sleep_seconds = min(max_delay_seconds, base_delay_seconds * (2 ** (attempt - 1)))
            sleep_seconds += random.uniform(0, jitter_seconds)

            if logger:
                logger.warning(
                    "Retrying external operation",
                    extra={
                        "operation": operation_name,
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "sleep_seconds": round(sleep_seconds, 3),
                        "error": str(error),
                    },
                )
            time.sleep(sleep_seconds)

    assert last_error is not None
    raise last_error


def _download_image_once(url: str) -> bytes:
    with requests.get(url, timeout=(5, DOWNLOAD_TIMEOUT_SECONDS), stream=True, allow_redirects=True) as response:
        response.raise_for_status()

        chunks: list[bytes] = []
        total_size = 0

        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total_size += len(chunk)
            if total_size > MAX_DOWNLOAD_BYTES:
                raise ValueError(f"Image is too large (>{MAX_DOWNLOAD_BYTES} bytes).")
            chunks.append(chunk)

    payload = b"".join(chunks)
    if not payload:
        raise ValueError("Downloaded image is empty.")
    return payload


def download_image_bytes(url: str, logger: logging.Logger | None = None) -> bytes:
    return retry_with_backoff(
        lambda: _download_image_once(url),
        retriable_exceptions=(requests.RequestException,),
        max_attempts=int(os.getenv("DOWNLOAD_MAX_RETRIES", "4")),
        base_delay_seconds=1.0,
        max_delay_seconds=20.0,
        logger=logger,
        operation_name="download_image",
    )
