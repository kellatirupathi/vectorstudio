from __future__ import annotations

import logging
import os
import random
import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse

from backend.config import load_environment
from backend.tasks import run_bulk_job_in_background
from backend.utils import (
    append_job_error,
    configure_logging,
    ensure_job_dirs,
    get_job_meta,
    initialize_job_meta,
    parse_input_links_csv,
    parse_urls_text,
    read_job_results,
    read_job_errors,
    sanitize_filename,
    save_job_manifest,
    start_sweeper,
    update_job_meta,
)

load_environment()
configure_logging()
logger = logging.getLogger(__name__)

app = FastAPI(title="Vector Image Bulk Stylizer", version="1.0.0")

ALLOWED_IMAGE_MODELS = {"gpt-image-1", "gpt-image-1-mini", "dall-e-2"}
MIN_VARIANTS_COUNT = 1
MAX_VARIANTS_COUNT = 10
ALLOWED_TRANSFORM_MODES = {"generate_from_reference", "edit"}
ALLOWED_POSE_STRENGTHS = {"subtle", "medium"}

allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "*").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"


@app.on_event("startup")
async def startup() -> None:
    start_sweeper()
    logger.info("In-process job store ready")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    index_file = FRONTEND_DIR / "index.html"
    if not index_file.exists():
        raise HTTPException(status_code=404, detail="frontend/index.html not found")
    return HTMLResponse(index_file.read_text(encoding="utf-8"))


@app.post("/jobs")
async def create_job(
    request: Request,
    images: list[UploadFile] | None = File(default=None),
    urls_text: str = Form(default=""),
    csv_file: UploadFile | None = File(default=None),
    model: str = Form(default=""),
    variants_count: int = Form(default=1),
    style_prompt: str = Form(default=""),
    pose_variation: bool = Form(default=False),
    pose_strength: str = Form(default="subtle"),
) -> dict[str, str | int | bool]:
    job_id = str(uuid4())
    _, inputs_dir = ensure_job_dirs(job_id)

    selected_model = (model or "").strip()
    if not selected_model:
        selected_model = os.getenv("OPENAI_IMAGE_MODEL", "gpt-image-1-mini")
    if selected_model not in ALLOWED_IMAGE_MODELS:
        allowed_models_text = ", ".join(sorted(ALLOWED_IMAGE_MODELS))
        raise HTTPException(status_code=400, detail=f"Invalid model. Allowed models: {allowed_models_text}")
    if not (MIN_VARIANTS_COUNT <= variants_count <= MAX_VARIANTS_COUNT):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid variants_count. Allowed range: {MIN_VARIANTS_COUNT}-{MAX_VARIANTS_COUNT}",
        )
    selected_transform_mode = os.getenv("IMAGE_TRANSFORM_MODE", "edit").strip().lower()
    if selected_transform_mode not in ALLOWED_TRANSFORM_MODES:
        selected_transform_mode = "edit"
    selected_style_prompt = (style_prompt or "").strip()
    if len(selected_style_prompt) > 1000:
        raise HTTPException(status_code=400, detail="style_prompt is too long. Max length is 1000 characters.")
    selected_pose_strength = (pose_strength or "subtle").strip().lower()
    if selected_pose_strength not in ALLOWED_POSE_STRENGTHS:
        allowed_pose_text = ", ".join(sorted(ALLOWED_POSE_STRENGTHS))
        raise HTTPException(status_code=400, detail=f"Invalid pose_strength. Allowed values: {allowed_pose_text}")
    selected_pose_variation_enabled = int(bool(pose_variation))

    items: list[dict[str, str | int]] = []
    index_counter = 0

    if images:
        for upload in images:
            original_name = sanitize_filename(upload.filename or f"uploaded_{index_counter}.png")
            local_name = f"{index_counter:06d}_{original_name}"
            local_path = inputs_dir / local_name

            with local_path.open("wb") as destination:
                shutil.copyfileobj(upload.file, destination)

            if local_path.stat().st_size <= 0:
                local_path.unlink(missing_ok=True)
                items.append(
                    {
                        "index": index_counter,
                        "input_image": original_name,
                        "source": "invalid_upload",
                        "model": selected_model,
                    }
                )
            else:
                items.append(
                    {
                        "index": index_counter,
                        "input_image": original_name,
                        "source": "upload",
                        "local_path": str(local_path),
                        "model": selected_model,
                    }
                )
            index_counter += 1
            await upload.close()

    url_inputs = parse_urls_text(urls_text)
    for raw_url in url_inputs:
        items.append(
            {
                "index": index_counter,
                "input_image": raw_url,
                "source": "url",
                "url": raw_url,
                "model": selected_model,
            }
        )
        index_counter += 1

    if csv_file is not None:
        csv_payload = await csv_file.read()
        await csv_file.close()
        if csv_payload:
            try:
                csv_urls = parse_input_links_csv(csv_payload)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

            for raw_url in csv_urls:
                items.append(
                    {
                        "index": index_counter,
                        "input_image": raw_url,
                        "source": "url",
                        "url": raw_url,
                        "model": selected_model,
                    }
                )
                index_counter += 1

    if selected_style_prompt:
        for item in items:
            item["style_prompt"] = selected_style_prompt
    for item in items:
        item["pose_variation_enabled"] = selected_pose_variation_enabled
        item["pose_strength"] = selected_pose_strength

    if not items:
        raise HTTPException(status_code=400, detail="No inputs provided. Add files, URLs, or a CSV.")

    expanded_items: list[dict[str, str | int]] = []
    expanded_index = 0
    for base_item in items:
        source = str(base_item.get("source", ""))
        # For bulk URL/CSV inputs, randomize variant assignment per image.
        # Example with variants_count=1: image A->7, image B->4, image C->2.
        if source == "url":
            random_variants = random.sample(range(1, MAX_VARIANTS_COUNT + 1), k=variants_count)
            for variant_index in random_variants:
                variant_item = dict(base_item)
                variant_item["index"] = expanded_index
                variant_item["variant_index"] = variant_index
                variant_item["variants_count"] = variants_count
                expanded_items.append(variant_item)
                expanded_index += 1
            continue

        for variant_index in range(1, variants_count + 1):
            variant_item = dict(base_item)
            variant_item["index"] = expanded_index
            variant_item["variant_index"] = variant_index
            variant_item["variants_count"] = variants_count
            expanded_items.append(variant_item)
            expanded_index += 1

    items = expanded_items

    save_job_manifest(job_id, items)
    initialize_job_meta(job_id, total=len(items))
    update_job_meta(
        job_id,
        {
            "selected_model": selected_model,
            "selected_variants_count": variants_count,
            "selected_transform_mode": selected_transform_mode,
            "selected_style_prompt_enabled": int(bool(selected_style_prompt)),
            "selected_pose_variation_enabled": selected_pose_variation_enabled,
            "selected_pose_strength": selected_pose_strength,
        },
    )

    try:
        run_bulk_job_in_background(job_id)
    except Exception as exc:
        append_job_error(job_id, "__job__", str(exc))
        update_job_meta(job_id, {"status": "failed", "failure_reason": str(exc)})
        logger.exception("Failed to start job", extra={"job_id": job_id, "error": str(exc)})
        raise HTTPException(status_code=500, detail="Failed to start job for processing") from exc

    return {
        "job_id": job_id,
        "status": "queued",
        "total": len(items),
        "selected_model": selected_model,
        "selected_variants_count": variants_count,
        "selected_transform_mode": selected_transform_mode,
        "selected_style_prompt_enabled": bool(selected_style_prompt),
        "selected_pose_variation_enabled": bool(selected_pose_variation_enabled),
        "selected_pose_strength": selected_pose_strength,
        "status_url": str(request.url_for("get_job", job_id=job_id)),
    }


@app.get("/jobs/{job_id}", name="get_job")
def get_job(
    job_id: str,
    request: Request,
    error_limit: int = Query(default=50, ge=0, le=500),
    result_limit: int = Query(default=100, ge=0, le=1000),
) -> dict:
    meta = get_job_meta(job_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Job not found")
    style_prompt_enabled_raw = meta.get("selected_style_prompt_enabled", 0)
    try:
        style_prompt_enabled = bool(int(style_prompt_enabled_raw))
    except (TypeError, ValueError):
        style_prompt_enabled = bool(style_prompt_enabled_raw)
    pose_variation_enabled_raw = meta.get("selected_pose_variation_enabled", 0)
    try:
        pose_variation_enabled = bool(int(pose_variation_enabled_raw))
    except (TypeError, ValueError):
        pose_variation_enabled = bool(pose_variation_enabled_raw)

    errors, total_errors = read_job_errors(job_id, limit=error_limit)
    result_rows, total_result_rows = read_job_results(job_id, limit=result_limit)

    download_url = None
    result_csv_path = meta.get("result_csv_path")
    if isinstance(result_csv_path, str) and result_csv_path and Path(result_csv_path).exists():
        download_url = str(request.url_for("download_job_csv", job_id=job_id))
    archived_result_csv_path = meta.get("archived_result_csv_path")

    return {
        "job_id": job_id,
        "status": meta.get("status", "queued"),
        "total": int(meta.get("total", 0)),
        "processed": int(meta.get("processed", 0)),
        "succeeded": int(meta.get("succeeded", 0)),
        "failed": int(meta.get("failed", 0)),
        "errors": errors,
        "total_errors": total_errors,
        "result_rows": result_rows,
        "total_result_rows": total_result_rows,
        "selected_model": meta.get("selected_model"),
        "selected_variants_count": int(meta.get("selected_variants_count", 1)),
        "selected_transform_mode": meta.get("selected_transform_mode"),
        "selected_style_prompt_enabled": style_prompt_enabled,
        "selected_pose_variation_enabled": pose_variation_enabled,
        "selected_pose_strength": meta.get("selected_pose_strength", "subtle"),
        "download_url": download_url,
        "archived_result_csv_path": archived_result_csv_path,
        "result_ready": bool(download_url),
        "created_at": meta.get("created_at"),
        "updated_at": meta.get("updated_at"),
    }


@app.get("/jobs/{job_id}/result.csv", name="download_job_csv")
def download_job_csv(job_id: str) -> FileResponse:
    meta = get_job_meta(job_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="Job not found")

    result_csv_path = meta.get("result_csv_path")
    if not result_csv_path:
        raise HTTPException(status_code=409, detail="Result CSV is not ready yet")

    csv_file_path = Path(str(result_csv_path))
    if not csv_file_path.exists():
        raise HTTPException(status_code=404, detail="Result CSV not found")

    return FileResponse(
        csv_file_path,
        media_type="text/csv",
        filename=f"{job_id}_result.csv",
    )
