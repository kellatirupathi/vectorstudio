from __future__ import annotations

"""
Drive-to-Cloud CSV converter (separate feature module).

Run:
1) pip install -r drivetocloud_requirements.txt
2) Set env vars (separate credentials for this module):
   - D2C_CLOUDINARY_CLOUD_NAME
   - D2C_CLOUDINARY_API_KEY
   - D2C_CLOUDINARY_API_SECRET
   - GOOGLE_APPLICATION_CREDENTIALS (service account path) OR OAuth vars:
     - GOOGLE_OAUTH_CLIENT_ID
     - GOOGLE_OAUTH_CLIENT_SECRET
     - GOOGLE_OAUTH_REDIRECT_URI (optional, default: http://localhost:8000/oauth2callback)
     - GOOGLE_OAUTH_TOKEN_PATH (optional, default: ./token_d2c.json)
3) uvicorn app:app --reload --host 0.0.0.0 --port 8000

This app mounts the existing backend app at / and adds a separate page at /drivetocloud.
"""

import csv
import io
import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4

import cloudinary
import cloudinary.uploader
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from google.oauth2.service_account import Credentials as ServiceAccountCredentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload

from backend.main import app as existing_app

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
ALLOWED_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "svg"}
DRIVE_SHARED_DRIVE_SUPPORT = os.getenv("DRIVE_SHARED_DRIVE_SUPPORT", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
BASE_DIR = Path(__file__).resolve().parent
D2C_STORAGE_DIR = BASE_DIR / "drivetocloud_storage"
D2C_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATES = Jinja2Templates(directory=str(BASE_DIR / "templates"))


@dataclass
class JobState:
    job_id: str
    input_rows: list[str]
    output_csv_path: Path
    total_rows: int
    processed_rows: int = 0
    status: str = "queued"
    current_drive_link: str = ""
    events: list[dict[str, Any]] = field(default_factory=list)
    output_values: list[str] = field(default_factory=list)
    file_cache: dict[str, str] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)
    condition: threading.Condition = field(init=False)
    failure_reason: str = ""

    def __post_init__(self) -> None:
        self.condition = threading.Condition(self.lock)
        self.output_values = ["" for _ in range(self.total_rows)]


class OAuthRequiredError(RuntimeError):
    def __init__(self, auth_url: str) -> None:
        super().__init__("OAuth authorization is required.")
        self.auth_url = auth_url


JOBS: dict[str, JobState] = {}
JOBS_LOCK = threading.Lock()
OAUTH_STATE_CACHE: dict[str, dict[str, Any]] = {}

app = FastAPI(title="Drive To Cloud", version="1.0.0")


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _json_event(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=True)}\n\n"


def _sanitize_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("_") or "file"


def _cloudinary_config() -> dict[str, str]:
    cloud_name = os.getenv("D2C_CLOUDINARY_CLOUD_NAME", "").strip()
    api_key = os.getenv("D2C_CLOUDINARY_API_KEY", "").strip()
    api_secret = os.getenv("D2C_CLOUDINARY_API_SECRET", "").strip()
    if not cloud_name or not api_key or not api_secret:
        raise RuntimeError(
            "Missing D2C Cloudinary credentials. Set D2C_CLOUDINARY_CLOUD_NAME, "
            "D2C_CLOUDINARY_API_KEY, D2C_CLOUDINARY_API_SECRET."
        )
    return {"cloud_name": cloud_name, "api_key": api_key, "api_secret": api_secret}


def _build_drive_service() -> Any:
    service_account_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if service_account_path:
        creds = ServiceAccountCredentials.from_service_account_file(service_account_path, scopes=SCOPES)
        return build("drive", "v3", credentials=creds, cache_discovery=False)

    token_path = Path(os.getenv("GOOGLE_OAUTH_TOKEN_PATH", str(BASE_DIR / "token_d2c.json")))
    creds: Credentials | None = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(GoogleAuthRequest())
        token_path.write_text(creds.to_json(), encoding="utf-8")

    if not creds or not creds.valid:
        client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "").strip()
        client_secret = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            raise RuntimeError(
                "Drive auth not configured. Set GOOGLE_APPLICATION_CREDENTIALS or OAuth env vars."
            )

        redirect_uri = os.getenv("GOOGLE_OAUTH_REDIRECT_URI", "http://localhost:8000/oauth2callback")
        state = str(uuid4())
        flow = Flow.from_client_config(
            {
                "web": {
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": [redirect_uri],
                }
            },
            scopes=SCOPES,
            state=state,
        )
        flow.redirect_uri = redirect_uri
        auth_url, generated_state = flow.authorization_url(
            access_type="offline",
            include_granted_scopes="true",
            prompt="consent",
        )
        OAUTH_STATE_CACHE[generated_state] = {
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "token_path": str(token_path),
            "created_at": time.time(),
        }
        raise OAuthRequiredError(auth_url=auth_url)

    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _extract_drive_id(raw: str) -> str:
    value = raw.strip()
    if not value:
        return ""

    id_match = re.fullmatch(r"[A-Za-z0-9_-]{10,}", value)
    if id_match:
        return value

    patterns = [
        r"/file/d/([A-Za-z0-9_-]+)",
        r"/drive/folders/([A-Za-z0-9_-]+)",
        r"[?&]id=([A-Za-z0-9_-]+)",
        r"/uc\?id=([A-Za-z0-9_-]+)",
    ]
    for pattern in patterns:
        m = re.search(pattern, value)
        if m:
            return m.group(1)
    return ""


def _is_image_file(mime_type: str, name: str) -> bool:
    if mime_type.startswith("image/"):
        return True
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext in ALLOWED_IMAGE_EXTENSIONS


def _get_file_meta(service: Any, file_id: str) -> dict[str, Any]:
    return (
        service.files()
        .get(
            fileId=file_id,
            fields="id,name,mimeType,shortcutDetails,targetId",
            supportsAllDrives=DRIVE_SHARED_DRIVE_SUPPORT,
        )
        .execute()
    )


def _iter_folder_children(service: Any, folder_id: str) -> Iterable[dict[str, Any]]:
    page_token: str | None = None
    while True:
        result = (
            service.files()
            .list(
                q=f"'{folder_id}' in parents and trashed=false",
                fields="nextPageToken, files(id,name,mimeType,shortcutDetails,targetId)",
                pageToken=page_token,
                includeItemsFromAllDrives=DRIVE_SHARED_DRIVE_SUPPORT,
                supportsAllDrives=DRIVE_SHARED_DRIVE_SUPPORT,
                pageSize=1000,
            )
            .execute()
        )
        for entry in result.get("files", []):
            yield entry
        page_token = result.get("nextPageToken")
        if not page_token:
            break


def _collect_image_file_ids(service: Any, file_id: str, seen: set[str] | None = None) -> list[str]:
    seen = seen or set()
    if file_id in seen:
        return []
    seen.add(file_id)

    try:
        meta = _get_file_meta(service, file_id)
    except HttpError:
        return []

    mime_type = (meta.get("mimeType") or "").strip().lower()
    name = str(meta.get("name") or "")

    if mime_type == "application/vnd.google-apps.shortcut":
        target_id = (
            (meta.get("shortcutDetails") or {}).get("targetId")
            or meta.get("targetId")
            or ""
        )
        if not target_id:
            return []
        return _collect_image_file_ids(service, target_id, seen=seen)

    if mime_type == "application/vnd.google-apps.folder":
        collected: list[str] = []
        for child in _iter_folder_children(service, file_id):
            child_id = str(child.get("id") or "")
            if not child_id:
                continue
            child_mime = str(child.get("mimeType") or "").lower()
            if child_mime == "application/vnd.google-apps.folder":
                collected.extend(_collect_image_file_ids(service, child_id, seen=seen))
                continue
            if child_mime == "application/vnd.google-apps.shortcut":
                target_id = ((child.get("shortcutDetails") or {}).get("targetId") or child.get("targetId") or "")
                if target_id:
                    collected.extend(_collect_image_file_ids(service, target_id, seen=seen))
                continue
            if _is_image_file(child_mime, str(child.get("name") or "")):
                collected.append(child_id)
        return collected

    if _is_image_file(mime_type, name):
        return [file_id]

    return []


def _download_drive_file_bytes(service: Any, file_id: str) -> tuple[bytes, str]:
    meta = _get_file_meta(service, file_id)
    name = str(meta.get("name") or file_id)

    request = service.files().get_media(fileId=file_id, supportsAllDrives=DRIVE_SHARED_DRIVE_SUPPORT)
    stream = io.BytesIO()
    downloader = MediaIoBaseDownload(stream, request)
    done = False
    while not done:
        _, done = downloader.next_chunk(num_retries=2)
    return stream.getvalue(), name


def _upload_to_cloudinary(image_bytes: bytes, file_id: str, name: str) -> str:
    creds = _cloudinary_config()
    cloudinary.config(
        cloud_name=creds["cloud_name"],
        api_key=creds["api_key"],
        api_secret=creds["api_secret"],
        secure=True,
    )
    today = datetime.utcnow().strftime("%Y-%m-%d")
    folder = f"drive_import/{today}"
    base_name = _sanitize_name(Path(name).stem)
    public_id = f"drive_{file_id}_{base_name}"

    payload = io.BytesIO(image_bytes)
    payload.name = name or f"{file_id}.bin"

    result = cloudinary.uploader.upload(
        payload,
        folder=folder,
        public_id=public_id,
        overwrite=True,
        resource_type="image",
    )
    secure_url = result.get("secure_url") or result.get("url")
    if not secure_url:
        raise RuntimeError("Cloudinary upload succeeded but no URL was returned")
    return str(secure_url)


def _write_output_csv(job: JobState) -> None:
    with job.output_csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["drive_link", "cloudinary_link"])
        for idx, drive_link in enumerate(job.input_rows):
            writer.writerow([drive_link, job.output_values[idx]])


def _push_event(job: JobState, status: str, drive_link: str, message: str = "") -> None:
    event = {
        "job_id": job.job_id,
        "status": status,
        "total_rows": job.total_rows,
        "processed_rows": job.processed_rows,
        "current_drive_link": drive_link,
        "message": message,
        "job_status": job.status,
        "timestamp": _now_iso(),
    }
    with job.condition:
        job.events.append(event)
        job.condition.notify_all()


def _process_job(job: JobState) -> None:
    try:
        job.status = "processing"
        _write_output_csv(job)
        _push_event(job, "started", "", "Job started")

        service = _build_drive_service()

        for idx, drive_link in enumerate(job.input_rows):
            current_status = "success"
            cloudinary_links: list[str] = []
            job.current_drive_link = drive_link

            try:
                drive_id = _extract_drive_id(drive_link)
                if not drive_id:
                    raise ValueError("Unable to parse Drive ID from link")

                file_ids = _collect_image_file_ids(service, drive_id)
                if not file_ids:
                    current_status = "fail"
                    cloudinary_links = []
                else:
                    for file_id in file_ids:
                        if file_id in job.file_cache:
                            cloudinary_links.append(job.file_cache[file_id])
                            continue

                        attempts = 0
                        uploaded_url = ""
                        while attempts < 3:
                            attempts += 1
                            try:
                                image_bytes, name = _download_drive_file_bytes(service, file_id)
                                uploaded_url = _upload_to_cloudinary(image_bytes, file_id=file_id, name=name)
                                break
                            except Exception:
                                if attempts >= 3:
                                    uploaded_url = ""
                                    break
                                time.sleep(0.7 * attempts)

                        if uploaded_url:
                            job.file_cache[file_id] = uploaded_url
                            cloudinary_links.append(uploaded_url)

                    if not cloudinary_links:
                        current_status = "fail"

                with job.lock:
                    job.output_values[idx] = " | ".join(cloudinary_links) if cloudinary_links else ""
                    job.processed_rows += 1
                    _write_output_csv(job)

                _push_event(job, current_status, drive_link)
            except Exception as exc:
                with job.lock:
                    job.output_values[idx] = ""
                    job.processed_rows += 1
                    _write_output_csv(job)
                _push_event(job, "fail", drive_link, str(exc))

        job.status = "completed"
        _push_event(job, "completed", "", "Job completed")
    except OAuthRequiredError as exc:
        job.status = "failed"
        job.failure_reason = f"OAuth authorization required: {exc.auth_url}"
        _push_event(job, "failed", job.current_drive_link, job.failure_reason)
    except Exception as exc:
        job.status = "failed"
        job.failure_reason = str(exc)
        _push_event(job, "failed", job.current_drive_link, job.failure_reason)


@app.get("/drivetocloud", response_class=HTMLResponse)
def drivetocloud_page(request: Request) -> HTMLResponse:
    return TEMPLATES.TemplateResponse("index.html", {"request": request})


@app.post("/upload")
async def upload_csv(file: UploadFile = File(...)) -> JSONResponse:
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a CSV file.")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded CSV is empty.")

    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "drive_link" not in [h.strip() for h in reader.fieldnames]:
        raise HTTPException(status_code=400, detail="CSV must contain a 'drive_link' header column.")

    rows: list[str] = []
    for row in reader:
        value = (row.get("drive_link") or "").strip()
        rows.append(value)

    if not rows:
        raise HTTPException(status_code=400, detail="No rows found in CSV.")

    try:
        _build_drive_service()
    except OAuthRequiredError as exc:
        return JSONResponse(
            {
                "auth_required": True,
                "auth_url": exc.auth_url,
                "message": "Authorize Google Drive and retry upload.",
            },
            status_code=200,
        )

    job_id = str(uuid4())
    job_dir = D2C_STORAGE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    output_csv = job_dir / "output.csv"

    job = JobState(job_id=job_id, input_rows=rows, output_csv_path=output_csv, total_rows=len(rows))
    with JOBS_LOCK:
        JOBS[job_id] = job

    worker = threading.Thread(target=_process_job, args=(job,), daemon=True)
    worker.start()

    return JSONResponse({"job_id": job_id, "total_rows": len(rows)})


@app.get("/events/{job_id}")
def stream_events(job_id: str, from_index: int = Query(default=0, ge=0)) -> StreamingResponse:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    def generator() -> Iterable[str]:
        idx = from_index
        snapshot = {
            "job_id": job.job_id,
            "status": "snapshot",
            "total_rows": job.total_rows,
            "processed_rows": job.processed_rows,
            "current_drive_link": job.current_drive_link,
            "job_status": job.status,
            "timestamp": _now_iso(),
        }
        yield _json_event(snapshot)

        while True:
            with job.condition:
                if idx < len(job.events):
                    while idx < len(job.events):
                        event = dict(job.events[idx])
                        event["event_index"] = idx
                        if job.status == "completed":
                            event["download_url"] = f"/download/{job.job_id}"
                        yield _json_event(event)
                        idx += 1
                    continue

                if job.status in {"completed", "failed"}:
                    terminal = {
                        "job_id": job.job_id,
                        "status": "completed" if job.status == "completed" else "failed",
                        "total_rows": job.total_rows,
                        "processed_rows": job.processed_rows,
                        "current_drive_link": "",
                        "job_status": job.status,
                        "download_url": f"/download/{job.job_id}" if job.status == "completed" else "",
                        "message": job.failure_reason,
                        "timestamp": _now_iso(),
                    }
                    yield _json_event(terminal)
                    break

                job.condition.wait(timeout=5)
                heartbeat = {
                    "job_id": job.job_id,
                    "status": "heartbeat",
                    "total_rows": job.total_rows,
                    "processed_rows": job.processed_rows,
                    "current_drive_link": job.current_drive_link,
                    "job_status": job.status,
                    "timestamp": _now_iso(),
                }
                yield _json_event(heartbeat)

    return StreamingResponse(generator(), media_type="text/event-stream")


@app.get("/download/{job_id}")
def download_output(job_id: str) -> FileResponse:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "completed":
        raise HTTPException(status_code=409, detail="Job not completed yet")
    if not job.output_csv_path.exists():
        raise HTTPException(status_code=404, detail="Output CSV missing")

    return FileResponse(
        path=job.output_csv_path,
        media_type="text/csv",
        filename=f"{job_id}_drive_to_cloud.csv",
    )


@app.get("/oauth2callback", response_class=HTMLResponse)
def oauth2callback(request: Request, state: str = "", code: str = "", error: str = "") -> HTMLResponse:
    if error:
        return HTMLResponse(f"OAuth failed: {error}", status_code=400)
    if not state or not code:
        return HTMLResponse("Missing OAuth state/code.", status_code=400)

    oauth_state = OAUTH_STATE_CACHE.get(state)
    if not oauth_state:
        return HTMLResponse("Invalid or expired OAuth state.", status_code=400)

    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": oauth_state["client_id"],
                "client_secret": oauth_state["client_secret"],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [oauth_state["redirect_uri"]],
            }
        },
        scopes=SCOPES,
        state=state,
    )
    flow.redirect_uri = oauth_state["redirect_uri"]

    try:
        flow.fetch_token(code=code)
    except Exception as exc:
        return HTMLResponse(f"Failed to fetch token: {exc}", status_code=400)

    token_path = Path(oauth_state["token_path"])
    token_path.write_text(flow.credentials.to_json(), encoding="utf-8")
    OAUTH_STATE_CACHE.pop(state, None)
    return HTMLResponse("OAuth success. You can return to /drivetocloud and start upload.")


# Include existing app routes directly so /drivetocloud and related endpoints
# remain first-class routes in the same router.
app.include_router(existing_app.router)
