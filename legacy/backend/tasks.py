from __future__ import annotations

import base64
import io
import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import cloudinary
import cloudinary.uploader
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    BadRequestError,
    OpenAI,
    RateLimitError,
)
from PIL import Image, ImageOps

from backend.config import load_environment
from backend.utils import (
    append_job_error,
    build_result_csv_rows,
    configure_logging,
    download_image_bytes,
    increment_job_progress,
    is_valid_url,
    load_job_manifest,
    read_job_results,
    refresh_live_result_csv,
    retry_with_backoff,
    store_job_result,
    update_job_meta,
    utcnow_iso,
    write_archived_result_csv,
    write_result_json,
    write_result_csv,
)

load_environment()
configure_logging()
logger = logging.getLogger(__name__)

# Number of images processed concurrently inside this process. The work is
# I/O-bound (OpenAI + Cloudinary calls), so threads parallelize it well despite
# the GIL. Set to 1 for strict one-by-one processing.
WORKER_CONCURRENCY = max(1, int(os.getenv("WORKER_CONCURRENCY", "8")))

_VALID_IMAGE_QUALITIES = {"low", "medium", "high", "auto"}
_VALID_TRANSFORM_MODES = {"generate_from_reference", "edit"}
_TRUE_VALUES = {"1", "true", "yes", "y", "on"}

OPENAI_IMAGE_MODEL = os.getenv("OPENAI_IMAGE_MODEL", "gpt-image-1-mini")
OPENAI_IMAGE_SIZE = os.getenv("OPENAI_IMAGE_SIZE", "1024x1024")
OPENAI_TIMEOUT_SECONDS = float(os.getenv("OPENAI_TIMEOUT_SECONDS", "120"))
EXTERNAL_MAX_RETRIES = int(os.getenv("EXTERNAL_MAX_RETRIES", "5"))
CLOUDINARY_FOLDER_PREFIX = os.getenv("CLOUDINARY_FOLDER_PREFIX", "vectorize_jobs")
OPENAI_IMAGE_QUALITY = os.getenv("OPENAI_IMAGE_QUALITY", "medium").strip().lower()
if OPENAI_IMAGE_QUALITY not in _VALID_IMAGE_QUALITIES:
    logger.warning(
        "Invalid OPENAI_IMAGE_QUALITY value; defaulting to medium",
        extra={"provided_quality": OPENAI_IMAGE_QUALITY},
    )
    OPENAI_IMAGE_QUALITY = "medium"

IMAGE_TRANSFORM_MODE = os.getenv("IMAGE_TRANSFORM_MODE", "edit").strip().lower()
if IMAGE_TRANSFORM_MODE not in _VALID_TRANSFORM_MODES:
    logger.warning(
        "Invalid IMAGE_TRANSFORM_MODE value; defaulting to edit",
        extra={"provided_transform_mode": IMAGE_TRANSFORM_MODE},
    )
    IMAGE_TRANSFORM_MODE = "edit"

IDENTITY_ANALYSIS_MODEL = os.getenv("IDENTITY_ANALYSIS_MODEL", "gpt-4o-mini").strip()
IDENTITY_ANALYSIS_ENABLED = os.getenv("IDENTITY_ANALYSIS_ENABLED", "1").strip().lower() in _TRUE_VALUES
FORCE_VARIANT_POSE_DIVERSITY = os.getenv("FORCE_VARIANT_POSE_DIVERSITY", "0").strip().lower() in _TRUE_VALUES

_OPENAI_CLIENT: OpenAI | None = None
_CLOUDINARY_CONFIGURED = False
DALLE2_MAX_INPUT_BYTES = 4 * 1024 * 1024
DALLE2_MAX_PROMPT_CHARS = 1000
MIN_IMAGE_SIDE = 256
VARIANT_STYLE_PRESETS: list[dict[str, str]] = [
    {
        "name": "prisma_pop_magenta",
        "instruction": (
            "Prisma-like vibrant vector portrait. "
            "Background: bright magenta/pink gradient with subtle grain/speckles. "
            "High contrast, glossy highlights on face, smooth gradients, bold color blocks."
        ),
    },
    {
        "name": "pastel_lilac_soft",
        "instruction": (
            "Soft pastel vector portrait. "
            "Background: lilac/purple gradient with faint diagonal brush/stripe shapes. "
            "Gentle highlights, smooth skin shading, clean minimal look."
        ),
    },
    {
        "name": "sepia_halo_ring",
        "instruction": (
            "Muted cinematic/sepia vector portrait with soft bloom. "
            "Background: circular halo behind the head with subtle ornamental patterning. "
            "Soft vignette, elegant tones, slightly dreamy lighting."
        ),
    },
    {
        "name": "mono_face_pink_geometric_ring",
        "instruction": (
            "Mostly monochrome/near-monochrome portrait (face + clothing desaturated). "
            "Background: bold pink/orange geometric circular ring with clean lines and arcs. "
            "Strong contrast, graphic poster style."
        ),
    },
    {
        "name": "neutral_studio_grey",
        "instruction": (
            "Clean realistic-vector portrait with warm skin tones. "
            "Background: smooth grey studio gradient, minimal, professional. "
            "Subtle rim light; crisp detailing; premium avatar finish."
        ),
    },
    {
        "name": "blue_sky_city_silhouette",
        "instruction": (
            "Clean vector portrait with soft daylight lighting. "
            "Background: light blue sky gradient with faint city/architectural silhouettes. "
            "Calm, airy look; subtle haze depth."
        ),
    },
    {
        "name": "teal_glow_aura",
        "instruction": (
            "Modern cinematic vector portrait. "
            "Background: teal glow aura behind the subject with soft particles/bokeh. "
            "Slight rim light, cool highlights, premium digital-art vibe."
        ),
    },
    {
        "name": "neon_rainbow_prisma",
        "instruction": (
            "Neon rainbow Prisma-style color segmentation across face and clothing. "
            "Background: vibrant orange/pink gradient with abstract circular tech shapes. "
            "High saturation, sharp edges, strong graphic color planes."
        ),
    },
    {
        "name": "three_quarter_lavender_mist",
        "instruction": (
            "Soft painterly-vector portrait. "
            "Background: lavender/grey misty gradient with faint blurred shapes. "
            "Maintain premium facial shading; subtle glow; calm tones."
        ),
    },
    {
        "name": "mono_teal_starry",
        "instruction": (
            "Monochrome/ink-like portrait rendering with strong tonal separation. "
            "Background: teal night-sky gradient with tiny star-like dots and simple skyline hints. "
            "Poster/print texture is acceptable but very subtle."
        ),
    },
]
VARIANT_OUTFIT_GUIDANCE: list[str] = [
    "Outfit vibe: premium techwear street style; futuristic jacket layering with subtle paneling and controlled neon seams; must suit the input person.",
    "Outfit vibe: minimal corporate-tech formal; clean tech blazer/shirt combo with subtle UI-line accents; must suit the input person.",
    "Outfit vibe: cinematic legacy-tech formal; elegant futuristic tailoring with muted metallic trims; must suit the input person.",
    "Outfit vibe: monochrome tactical-tech silhouette; structured coat/jacket with refined panel geometry; must suit the input person.",
    "Outfit vibe: executive tech portrait; premium futuristic business wear with precise seam detailing; must suit the input person.",
    "Outfit vibe: smart casual techwear; breathable futuristic outer layer with understated circuitry motifs; must suit the input person.",
    "Outfit vibe: cinematic high-tech jacket profile; contemporary techwear with subtle illuminated accents; must suit the input person.",
    "Outfit vibe: bold futuristic fashion-tech; stronger neon paneling while staying wearable and premium; must suit the input person.",
    "Outfit vibe: editorial soft-tech styling; classy futuristic fabric textures and clean panel transitions; must suit the input person.",
    "Outfit vibe: monochrome formal-tech tailoring; minimalist futuristic attire with strong tonal separation; must suit the input person.",
]
POSE_VARIATION_PRESETS: list[dict[str, str]] = [
    {"name": "front_facing_neutral", "instruction": "Front-facing neutral head-and-shoulders pose with minimal turn."},
    {"name": "three_quarter_left", "instruction": "Slight three-quarter view turned to the left."},
    {"name": "three_quarter_right", "instruction": "Slight three-quarter view turned to the right."},
    {"name": "slight_head_tilt_left", "instruction": "Subtle head tilt toward the left with natural eye line."},
    {"name": "slight_head_tilt_right", "instruction": "Subtle head tilt toward the right with natural eye line."},
    {"name": "chin_slightly_up_confident", "instruction": "Chin slightly up for a confident portrait angle."},
    {"name": "chin_slightly_down_soft", "instruction": "Chin slightly down for a softer portrait angle."},
    {"name": "shoulders_angled_left", "instruction": "Shoulders angled slightly left while keeping face identity consistent."},
    {"name": "shoulders_angled_right", "instruction": "Shoulders angled slightly right while keeping face identity consistent."},
    {"name": "closer_crop_headshot", "instruction": "Slightly closer headshot crop while staying head-and-shoulders."},
]
TECH_STYLE_BLOCK = (
    "TECH STYLE (MANDATORY): futuristic tech-inspired avatar aesthetic with clean structured vector finish; "
    "background must use abstract tech graphics only (HUD rings, subtle circuit traces, UI glow, geometric light panels, particles) "
    "with NO realistic scenery; keep output clean and uncluttered."
)
GENDER_ADAPTIVE_STYLE_BLOCK = (
    "INPUT-ADAPTIVE STYLING (MANDATORY): infer gender presentation and age vibe from the input photo and keep that presentation consistent. "
    "Select techwear outfit cuts/details appropriate to the same person; do not force masculine/feminine traits not present in the input."
)
BOARDING_PASS_COLOR_BLOCK = (
    "COLOR RULE (MANDATORY): adapt background and accent colors to harmonize with a red boarding-pass theme; "
    "do not restrict to blue-only tones."
)


class NonRetriableOpenAIError(Exception):
    """Signals 4xx OpenAI errors that should not be retried."""


def _build_vectorize_prompt() -> str:
    return (
        "Avatar Conversion (Image-to-Image AI Step)\n"
        "Use the uploaded student photo as the reference image.\n\n"
        "IDENTITY PRESERVATION (CRITICAL):\n"
        "- Preserve 100% facial identity.\n"
        "- Maintain exact face shape, jawline, cheekbones, nose, lips, and eye spacing.\n"
        "- Keep hairstyle, hairline, and facial hair accurate.\n"
        "- The student must remain clearly recognizable.\n\n"
        "STYLE DIRECTION:\n"
        "- Futuristic tech-inspired digital avatar.\n"
        "- Clean structured vector illustration.\n"
        "- Slightly enhanced symmetry is allowed without altering identity.\n"
        "- Modern, confident expression.\n\n"
        "VISUAL STYLE:\n"
        "- Flat vector design.\n"
        "- Smooth solid fills.\n"
        "- Clean sharp scalable edges.\n"
        "- Minimal gradients.\n"
        "- Controlled geometric shading.\n"
        "- Subtle neon rim lighting.\n"
        "- Consistent line weight.\n"
        "- No photorealism.\n"
        "- No painterly texture.\n"
        "- No noise.\n\n"
        "COLOR RULES:\n"
        "- Adapt the background and accent colors to harmonize with a red boarding pass theme.\n"
        "- Do not restrict to blue tones.\n\n"
        "BACKGROUND:\n"
        "- Minimal futuristic gradient or soft abstract tech backdrop.\n"
        "- Clean and uncluttered.\n\n"
        "OUTPUT:\n"
        "- Output must be high-resolution and suitable for profile or app display.\n"
        "- 1:1 square portrait, centered head-and-shoulders."
    )


def _normalize_variant_index(variant_index: int) -> int:
    if variant_index < 1:
        return 1
    if variant_index > len(VARIANT_STYLE_PRESETS):
        return len(VARIANT_STYLE_PRESETS)
    return variant_index


def _build_variant_prompt(
    variant_index: int,
    variants_count: int,
    style_prompt_override: str = "",
    pose_variation_enabled: bool = False,
    pose_strength: str = "subtle",
    pose_preset_name: str = "",
    pose_preset_instruction: str = "",
) -> tuple[int, str, str]:
    normalized_index = _normalize_variant_index(variant_index)
    safe_total = max(1, variants_count)
    preset = VARIANT_STYLE_PRESETS[normalized_index - 1]
    variant_name = preset["name"]
    variant_instruction = preset["instruction"]
    outfit_hint = VARIANT_OUTFIT_GUIDANCE[normalized_index - 1]
    base_prompt = style_prompt_override.strip() if style_prompt_override.strip() else VECTORIZE_PROMPT

    prompt_text = (
        f"{base_prompt} "
        f"{TECH_STYLE_BLOCK} "
        f"{GENDER_ADAPTIVE_STYLE_BLOCK} "
        f"{BOARDING_PASS_COLOR_BLOCK} "
        "Identity lock for this variant: same exact person and facial geometry from the input. "
        "Do NOT change face shape/jaw, eye shape or spacing, eyebrow shape, nose structure, lip shape, beard/mustache style, "
        "hairline/hairstyle, expression, head angle, framing/crop, or pose. "
        f"Variant {normalized_index}/{safe_total} style profile: {variant_name}. "
        f"{variant_instruction} "
        "MANDATORY OUTFIT CHANGE: Change the outfit for this variant to a clear techwear/futuristic clothing style. "
        "Outfit must be different across variants and must be appropriate for the input person (gender presentation, age vibe, body proportions). "
        "Do NOT alter body shape, neck shape, pose, or framing; only change the clothing design/colors/patterns. "
        "Clothing change must be clearly visible in the collar/neckline and upper torso area. "
        f"{outfit_hint} "
        "Only allowed changes: illustration style + background graphics + clothing. Everything else must match the input."
    )
    if pose_variation_enabled:
        strength_instruction = (
            "Pose strength: noticeable 3/4 + shoulder angle, but not extreme."
            if pose_strength == "medium"
            else "Pose strength: very slight turn/tilt only."
        )
        pose_name = pose_preset_name.strip() or "front_facing_neutral"
        pose_instruction = pose_preset_instruction.strip() or "Front-facing neutral head-and-shoulders pose."
        prompt_text += (
            " POSE VARIATION (NEW FEATURE): "
            f"For this variant, adjust pose/framing as: {pose_name}. {pose_instruction} "
            f"{strength_instruction} "
            "Keep the same person; keep facial geometry identical; no face reshaping. "
            "Head & shoulders only, square crop, centered. "
            "Do not change hairstyle/beard shape; keep consistent."
        )
    return normalized_index, variant_name, prompt_text


def _get_pose_preset(variant_index: int) -> tuple[str, str]:
    normalized_index = _normalize_variant_index(variant_index)
    preset = POSE_VARIATION_PRESETS[normalized_index - 1]
    return preset["name"], preset["instruction"]


CUSTOM_VECTORIZE_PROMPT = os.getenv("VECTORIZE_PROMPT", "").strip()
VECTORIZE_PROMPT = CUSTOM_VECTORIZE_PROMPT if CUSTOM_VECTORIZE_PROMPT else _build_vectorize_prompt()
logger.info(
    "Configured vector style prompt",
    extra={
        "transform_mode": IMAGE_TRANSFORM_MODE,
        "identity_analysis_model": IDENTITY_ANALYSIS_MODEL,
        "identity_analysis_enabled": IDENTITY_ANALYSIS_ENABLED,
        "uses_custom_prompt": bool(CUSTOM_VECTORIZE_PROMPT),
    },
)


def _extract_required_model(error_message: str) -> str | None:
    match = re.search(r"Value must be '([^']+)'", error_message)
    if not match:
        return None
    return match.group(1).strip()


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if hasattr(block, "text") and isinstance(getattr(block, "text"), str):
                parts.append(getattr(block, "text"))
            if isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return " ".join(part for part in parts if part).strip()
    return str(content).strip()


def _clamp_prompt_for_model(prompt_text: str, model_name: str) -> str:
    if model_name == "dall-e-2" and len(prompt_text) > DALLE2_MAX_PROMPT_CHARS:
        logger.warning(
            "Prompt exceeds dall-e-2 limit; truncating prompt",
            extra={"max_prompt_chars": DALLE2_MAX_PROMPT_CHARS, "original_prompt_chars": len(prompt_text)},
        )
        return prompt_text[:DALLE2_MAX_PROMPT_CHARS]
    return prompt_text


def _extract_image_bytes_from_openai_response(response: Any) -> bytes:
    if not getattr(response, "data", None):
        raise RuntimeError("OpenAI image response is empty.")

    image_record = response.data[0]
    b64_payload = getattr(image_record, "b64_json", None)
    if b64_payload:
        return base64.b64decode(b64_payload)

    image_url = getattr(image_record, "url", None)
    if image_url:
        return download_image_bytes(image_url, logger=logger)

    raise RuntimeError("OpenAI image response did not contain image bytes.")


def _describe_reference_identity(input_image_bytes: bytes) -> str:
    client = get_openai_client()
    image_b64 = base64.b64encode(input_image_bytes).decode("ascii")
    image_data_url = f"data:image/png;base64,{image_b64}"

    system_prompt = (
        "You extract strict, immutable facial identity fingerprints for consistent portrait generation.\n"
        "Output plain text only, compact, deterministic, and stable across repeated runs.\n"
        "Never use subjective adjectives (e.g., handsome, beautiful, sharp)."
    )
    user_prompt = (
        "Analyze this portrait and return one compact identity fingerprint line using this exact key order and format:\n"
        "face_shape=...; jawline_chin=...; eye_shape_spacing_eyelid=...; eyebrow_thickness_curve=...; "
        "nose_bridge_tip_nostril_width=...; lip_shape_upper_lower=...; beard_mustache_style_density_edges=...; "
        "hairline_hairstyle_volume_parting=...; skin_tone_category=...; expression_head_angle=...\n"
        "Rules:\n"
        "- Include only immutable facial structure cues.\n"
        "- Keep wording specific and concrete.\n"
        "- Do NOT include attractiveness, beauty, or artistic terms.\n"
        "- Do NOT include background, clothing, accessories, or lighting style.\n"
        "- If unknown, use the word 'unknown'.\n"
        "- Return exactly one plain-text line."
    )

    def _invoke_analysis() -> str:
        response = client.chat.completions.create(
            model=IDENTITY_ANALYSIS_MODEL,
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_prompt},
                        {"type": "image_url", "image_url": {"url": image_data_url}},
                    ],
                },
            ],
        )
        if not response.choices:
            return ""
        content = response.choices[0].message.content
        return _content_to_text(content)

    try:
        description = retry_with_backoff(
            _invoke_analysis,
            retriable_exceptions=(RateLimitError, APITimeoutError, APIConnectionError, APIStatusError),
            max_attempts=EXTERNAL_MAX_RETRIES,
            base_delay_seconds=1.0,
            max_delay_seconds=20.0,
            logger=logger,
            operation_name="identity_analysis",
        )
        return description[:500]
    except Exception as exc:
        logger.warning(
            "Identity analysis failed; proceeding with style prompt only",
            extra={"error": str(exc), "analysis_model": IDENTITY_ANALYSIS_MODEL},
        )
        return ""


def _build_generation_prompt_from_reference(
    identity_description: str,
    base_prompt_text: str,
    variant_name: str | None = None,
    pose_variation_clause: str | None = None,
    tech_style_enabled: bool = False,
) -> str:
    identity_clause = (
        f"Reference identity details: {identity_description}. "
        if identity_description
        else "Reference identity details are from the provided input portrait. "
    )
    variant_clause = f"Apply variant profile: {variant_name}. " if variant_name else ""
    pose_line = (
        "Pose/framing guidance: preserve expression and framing from the input reference. "
        if not pose_variation_clause
        else (
            "Pose/framing guidance: controlled pose variation is allowed for this variant while identity remains fixed. "
            f"{pose_variation_clause} "
        )
    )
    tech_line = f"{TECH_STYLE_BLOCK} " if tech_style_enabled else ""
    adaptive_style_line = f"{GENDER_ADAPTIVE_STYLE_BLOCK} " if tech_style_enabled else ""
    color_rule_line = f"{BOARDING_PASS_COLOR_BLOCK} " if tech_style_enabled else ""
    return (
        f"{base_prompt_text} "
        "Create a NEW stylized portrait image based on the reference identity. "
        "Identity is the highest priority. "
        "Do NOT change facial proportions. "
        "Do NOT change person, age, ethnicity, gender. "
        "Keep the same exact facial geometry. "
        "Preserve face shape, jawline, eye shape/spacing, eyebrows, nose structure, lip shape, beard/mustache style, hairline, and hairstyle. "
        f"{pose_line}"
        f"{tech_line}"
        f"{adaptive_style_line}"
        f"{color_rule_line}"
        "Only style may vary: color palette, shading, contour/line weight, and background aesthetics. "
        f"{variant_clause}"
        f"{identity_clause}"
        "Output must remain the same person across all variants."
    )


def _build_edit_prompt(base_prompt_text: str, variant_name: str | None = None) -> str:
    variant_clause = f"Apply variant profile: {variant_name}. " if variant_name else ""
    return (
        f"{base_prompt_text} "
        "Edit the PROVIDED input image directly. "
        "Preserve the exact same person identity and facial geometry. "
        "Do NOT change face shape, eye spacing/shape, nose structure, lip shape, jawline, hairline, hairstyle, expression, head angle, framing, or pose. "
        "Do NOT swap person. "
        "Do NOT make beauty edits, de-aging, face reshaping, or facial feature redesign. "
        f"{variant_clause}"
        "Only change visual style: vector/cartoon rendering, color blocks, gradients, contour lines, and simplified background."
    )


def _normalize_input_image(image_bytes: bytes) -> bytes:
    """
    Normalize incoming images to satisfy strict OpenAI image constraints:
    - PNG format
    - RGBA color mode
    - payload below 4 MB for account/model compatibility
    """
    try:
        with Image.open(io.BytesIO(image_bytes)) as source_image:
            image = ImageOps.exif_transpose(source_image)
            if image.mode != "RGBA":
                image = image.convert("RGBA")

            # Encode once first; often this already satisfies the limit.
            output = io.BytesIO()
            image.save(output, format="PNG", optimize=True, compress_level=9)
            encoded = output.getvalue()
            if len(encoded) <= DALLE2_MAX_INPUT_BYTES:
                return encoded

            # If still too large, progressively downscale until it fits or we hit a safe lower bound.
            width, height = image.size
            for _ in range(10):
                width = max(int(width * 0.85), MIN_IMAGE_SIDE)
                height = max(int(height * 0.85), MIN_IMAGE_SIDE)
                resized = image.resize((width, height), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                resized.save(output, format="PNG", optimize=True, compress_level=9)
                encoded = output.getvalue()
                if len(encoded) <= DALLE2_MAX_INPUT_BYTES:
                    return encoded
                if width <= MIN_IMAGE_SIDE or height <= MIN_IMAGE_SIDE:
                    break

            raise ValueError("Input image is too large after normalization. Please use a smaller image.")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"Unable to process input image: {exc}") from exc


def get_openai_client() -> OpenAI:
    global _OPENAI_CLIENT

    if _OPENAI_CLIENT is not None:
        return _OPENAI_CLIENT

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required.")

    _OPENAI_CLIENT = OpenAI(api_key=api_key, timeout=OPENAI_TIMEOUT_SECONDS)
    return _OPENAI_CLIENT


def ensure_cloudinary_config() -> None:
    global _CLOUDINARY_CONFIGURED

    if _CLOUDINARY_CONFIGURED:
        return

    cloud_name = os.getenv("CLOUDINARY_CLOUD_NAME")
    api_key = os.getenv("CLOUDINARY_API_KEY")
    api_secret = os.getenv("CLOUDINARY_API_SECRET")

    if not cloud_name or not api_key or not api_secret:
        raise RuntimeError(
            "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required."
        )

    cloudinary.config(
        cloud_name=cloud_name,
        api_key=api_key,
        api_secret=api_secret,
        secure=True,
    )
    _CLOUDINARY_CONFIGURED = True


def _read_input_bytes(item: dict[str, Any]) -> bytes:
    source = item.get("source")
    if source == "invalid_upload":
        raise ValueError("Uploaded file is empty.")

    if source == "upload":
        local_path = item.get("local_path")
        if not local_path:
            raise ValueError("Uploaded file path is missing.")
        path = Path(local_path)
        if not path.exists():
            raise FileNotFoundError(f"Uploaded file not found: {path}")
        payload = path.read_bytes()
        if not payload:
            raise ValueError("Uploaded file is empty.")
        return payload

    if source == "url":
        url = (item.get("url") or "").strip()
        if not is_valid_url(url):
            raise ValueError("Invalid image URL.")
        return download_image_bytes(url, logger=logger)

    raise ValueError("Unsupported input source.")


def _vectorize_image_with_openai_generate(
    prompt_text: str, requested_model: str | None = None
) -> tuple[bytes, str]:
    client = get_openai_client()
    starting_model = (requested_model or "").strip() or OPENAI_IMAGE_MODEL
    model_in_use = {"value": starting_model}

    def _request_generate() -> Any:
        payload: dict[str, Any] = {
            "model": model_in_use["value"],
            "prompt": _clamp_prompt_for_model(prompt_text, model_in_use["value"]),
            "size": OPENAI_IMAGE_SIZE,
        }

        # gpt-image models already return base64; forcing response_format can be rejected.
        if not model_in_use["value"].startswith("gpt-image-1"):
            payload["response_format"] = "b64_json"
        else:
            payload["output_format"] = "png"

        if OPENAI_IMAGE_QUALITY:
            payload["quality"] = OPENAI_IMAGE_QUALITY

        quality_fallback_applied = False
        model_fallback_applied = False
        response_format_fallback_applied = False

        while True:
            try:
                return client.images.generate(**payload)
            except BadRequestError as exc:
                message = str(exc)
                if (
                    not response_format_fallback_applied
                    and "Unknown parameter: 'response_format'" in message
                    and "response_format" in payload
                ):
                    logger.warning(
                        "OpenAI generate endpoint rejected response_format; retrying without response_format",
                    )
                    payload.pop("response_format", None)
                    response_format_fallback_applied = True
                    continue
                if (
                    not quality_fallback_applied
                    and (
                        "Unknown parameter: 'quality'" in message
                        or ("quality" in message and "Invalid value" in message)
                    )
                    and "quality" in payload
                ):
                    logger.warning(
                        "OpenAI generate endpoint rejected quality; retrying without quality",
                        extra={"requested_quality": OPENAI_IMAGE_QUALITY},
                    )
                    payload.pop("quality", None)
                    quality_fallback_applied = True
                    continue

                if not model_fallback_applied and "Value must be" in message and "model" in message:
                    required_model = _extract_required_model(message)
                    if required_model and payload.get("model") != required_model:
                        logger.warning(
                            "OpenAI generate endpoint rejected configured model; retrying with required model",
                            extra={"configured_model": payload.get("model"), "required_model": required_model},
                        )
                        payload["model"] = required_model
                        model_in_use["value"] = required_model
                        payload["prompt"] = _clamp_prompt_for_model(prompt_text, required_model)
                        model_fallback_applied = True
                        continue
                raise

    def _invoke_openai() -> tuple[bytes, str]:
        try:
            response = _request_generate()
        except APIStatusError as exc:
            status_code = getattr(exc, "status_code", None)
            if status_code is not None and status_code < 500 and status_code != 429:
                raise NonRetriableOpenAIError(str(exc)) from exc
            raise
        return _extract_image_bytes_from_openai_response(response), model_in_use["value"]

    return retry_with_backoff(
        _invoke_openai,
        retriable_exceptions=(RateLimitError, APITimeoutError, APIConnectionError, APIStatusError),
        max_attempts=EXTERNAL_MAX_RETRIES,
        base_delay_seconds=1.0,
        max_delay_seconds=30.0,
        logger=logger,
        operation_name="openai_image_generate",
    )


def _vectorize_image_with_openai_edit(
    input_image_bytes: bytes,
    prompt_text: str,
    requested_model: str | None = None,
) -> tuple[bytes, str]:
    client = get_openai_client()
    prepared_reference = _normalize_input_image(input_image_bytes)
    starting_model = (requested_model or "").strip() or OPENAI_IMAGE_MODEL
    model_in_use = {"value": starting_model}

    def _request_edit() -> Any:
        payload: dict[str, Any] = {
            "model": model_in_use["value"],
            "prompt": _clamp_prompt_for_model(prompt_text, model_in_use["value"]),
            "size": OPENAI_IMAGE_SIZE,
            "output_format": "png",
            "input_fidelity": "high",
        }

        if OPENAI_IMAGE_QUALITY:
            payload["quality"] = OPENAI_IMAGE_QUALITY

        quality_fallback_applied = False
        fidelity_fallback_applied = False
        model_fallback_applied = False

        while True:
            try:
                input_stream = io.BytesIO(prepared_reference)
                input_stream.name = "input.png"
                payload["image"] = input_stream
                return client.images.edit(**payload)
            except BadRequestError as exc:
                message = str(exc)
                message_lower = message.lower()
                if (
                    not fidelity_fallback_applied
                    and (
                        "unknown parameter: 'input_fidelity'" in message_lower
                        or ("input_fidelity" in message_lower and "invalid value" in message_lower)
                        or ("input_fidelity" in message_lower and "not supported" in message_lower)
                        or "invalid_input_fidelity_model" in message_lower
                    )
                    and "input_fidelity" in payload
                ):
                    logger.warning(
                        "OpenAI edit endpoint rejected input_fidelity; retrying without input_fidelity",
                    )
                    payload.pop("input_fidelity", None)
                    fidelity_fallback_applied = True
                    continue

                if (
                    not quality_fallback_applied
                    and (
                        "Unknown parameter: 'quality'" in message
                        or ("quality" in message and "Invalid value" in message)
                    )
                    and "quality" in payload
                ):
                    logger.warning(
                        "OpenAI edit endpoint rejected quality; retrying without quality",
                        extra={"requested_quality": OPENAI_IMAGE_QUALITY},
                    )
                    payload.pop("quality", None)
                    quality_fallback_applied = True
                    continue

                if not model_fallback_applied and "Value must be" in message and "model" in message:
                    required_model = _extract_required_model(message)
                    if required_model and payload.get("model") != required_model:
                        logger.warning(
                            "OpenAI edit endpoint rejected configured model; retrying with required model",
                            extra={"configured_model": payload.get("model"), "required_model": required_model},
                        )
                        payload["model"] = required_model
                        model_in_use["value"] = required_model
                        payload["prompt"] = _clamp_prompt_for_model(prompt_text, required_model)
                        model_fallback_applied = True
                        continue
                raise

    def _invoke_openai() -> tuple[bytes, str]:
        try:
            response = _request_edit()
        except APIStatusError as exc:
            status_code = getattr(exc, "status_code", None)
            if status_code is not None and status_code < 500 and status_code != 429:
                raise NonRetriableOpenAIError(str(exc)) from exc
            raise
        return _extract_image_bytes_from_openai_response(response), model_in_use["value"]

    return retry_with_backoff(
        _invoke_openai,
        retriable_exceptions=(RateLimitError, APITimeoutError, APIConnectionError, APIStatusError),
        max_attempts=EXTERNAL_MAX_RETRIES,
        base_delay_seconds=1.0,
        max_delay_seconds=30.0,
        logger=logger,
        operation_name="openai_image_edit",
    )


def _vectorize_image_with_openai(
    input_image_bytes: bytes,
    requested_model: str | None = None,
    prompt_text: str | None = None,
    variant_name: str | None = None,
    allow_pose_variation: bool = False,
    pose_variation_clause: str | None = None,
) -> tuple[bytes, str]:
    base_prompt = (prompt_text or VECTORIZE_PROMPT).strip()

    if IMAGE_TRANSFORM_MODE == "edit" and not allow_pose_variation:
        edit_prompt = _build_edit_prompt(base_prompt_text=base_prompt, variant_name=variant_name)
        return _vectorize_image_with_openai_edit(
            input_image_bytes=input_image_bytes,
            prompt_text=edit_prompt,
            requested_model=requested_model,
        )

    # Reference-based generation mode:
    # 1) analyze reference identity from input photo
    # 2) generate a fresh stylized image from prompt + extracted identity details
    prepared_reference = _normalize_input_image(input_image_bytes)
    identity_description = ""
    if IDENTITY_ANALYSIS_ENABLED:
        identity_description = _describe_reference_identity(prepared_reference)
    generation_prompt = _build_generation_prompt_from_reference(
        identity_description,
        base_prompt_text=base_prompt,
        variant_name=variant_name,
        pose_variation_clause=pose_variation_clause if allow_pose_variation else None,
        tech_style_enabled=allow_pose_variation,
    )
    return _vectorize_image_with_openai_generate(
        generation_prompt,
        requested_model=requested_model,
    )


def _upload_png_to_cloudinary(png_bytes: bytes, job_id: str, index: int) -> str:
    ensure_cloudinary_config()

    folder = f"{CLOUDINARY_FOLDER_PREFIX}/{job_id}"
    public_id = f"vector_{index:06d}"

    def _upload() -> str:
        stream = io.BytesIO(png_bytes)
        stream.name = f"{public_id}.png"

        result = cloudinary.uploader.upload(
            stream,
            folder=folder,
            public_id=public_id,
            overwrite=True,
            resource_type="image",
            format="png",
        )

        secure_url = result.get("secure_url") or result.get("url")
        if not secure_url:
            raise RuntimeError("Cloudinary did not return a public URL.")
        return secure_url

    return retry_with_backoff(
        _upload,
        retriable_exceptions=(Exception,),
        max_attempts=EXTERNAL_MAX_RETRIES,
        base_delay_seconds=1.0,
        max_delay_seconds=20.0,
        logger=logger,
        operation_name="cloudinary_upload",
    )


def start_bulk_job(job_id: str) -> dict[str, Any]:
    """
    Run the whole job to completion in this process.

    Items are processed by a bounded thread pool (WORKER_CONCURRENCY); the call
    returns only once every item is done and the job has been finalized. Callers
    that must not block should invoke this via `run_bulk_job_in_background`.
    """
    try:
        items = load_job_manifest(job_id)
        live_csv_path = write_result_csv(job_id, [])
        update_job_meta(
            job_id,
            {
                "status": "processing",
                "started_at": utcnow_iso(),
                "selected_transform_mode": IMAGE_TRANSFORM_MODE,
                "result_csv_path": str(live_csv_path),
            },
        )

        if not items:
            csv_path = write_result_csv(job_id, [])
            write_result_json(job_id, [])
            update_job_meta(
                job_id,
                {
                    "status": "completed",
                    "completed_at": utcnow_iso(),
                    "result_csv_path": str(csv_path),
                },
            )
            return {"job_id": job_id, "total": 0}

        concurrency = min(WORKER_CONCURRENCY, len(items))
        logger.info(
            "Processing image items",
            extra={"job_id": job_id, "total_items": len(items), "concurrency": concurrency},
        )

        results: list[dict[str, Any]] = []
        with ThreadPoolExecutor(
            max_workers=concurrency, thread_name_prefix=f"job-{job_id[:8]}"
        ) as executor:
            futures = [executor.submit(process_image_item, job_id, item) for item in items]
            for future in as_completed(futures):
                try:
                    results.append(future.result())
                except Exception as exc:
                    # process_image_item handles its own errors; this only fires
                    # on an unexpected crash, which must not abort the job.
                    logger.exception(
                        "Image task crashed", extra={"job_id": job_id, "error": str(exc)}
                    )

        finalize_job(results, job_id)
        return {"job_id": job_id, "total": len(items)}
    except Exception as exc:
        append_job_error(job_id, "__job__", str(exc))
        update_job_meta(job_id, {"status": "failed", "failed_at": utcnow_iso(), "failure_reason": str(exc)})
        logger.exception("Bulk job orchestration failed", extra={"job_id": job_id, "error": str(exc)})
        raise


def run_bulk_job_in_background(job_id: str) -> None:
    """Start `start_bulk_job` on a daemon thread so the caller returns at once."""

    def _run() -> None:
        try:
            start_bulk_job(job_id)
        except Exception:
            # start_bulk_job already recorded the failure in the job store.
            logger.exception("Background job thread ended with error", extra={"job_id": job_id})

    threading.Thread(target=_run, name=f"bulk-job-{job_id[:8]}", daemon=True).start()


def process_image_item(job_id: str, item: dict[str, Any]) -> dict[str, Any]:
    input_image = str(item.get("input_image", ""))
    index = int(item.get("index", 0))
    requested_model = str(item.get("model", "")).strip() or OPENAI_IMAGE_MODEL
    variants_count = int(item.get("variants_count", 1) or 1)
    variant_index = int(item.get("variant_index", 1) or 1)
    style_prompt_override = str(item.get("style_prompt", "")).strip()
    pose_variation_enabled = bool(int(item.get("pose_variation_enabled", 0) or 0))
    pose_strength = str(item.get("pose_strength", "subtle")).strip().lower()
    if pose_strength not in {"subtle", "medium"}:
        pose_strength = "subtle"
    force_pose_diversity_enabled = FORCE_VARIANT_POSE_DIVERSITY and variants_count > 1
    effective_pose_variation_enabled = pose_variation_enabled or force_pose_diversity_enabled
    # Keep identity retention high by defaulting forced multi-variant pose changes to subtle.
    effective_pose_strength = "subtle" if force_pose_diversity_enabled else pose_strength
    pose_preset_name, pose_preset_instruction = _get_pose_preset(variant_index)
    normalized_variant_index, variant_name, variant_prompt = _build_variant_prompt(
        variant_index,
        variants_count,
        style_prompt_override=style_prompt_override,
        pose_variation_enabled=effective_pose_variation_enabled,
        pose_strength=effective_pose_strength,
        pose_preset_name=pose_preset_name,
        pose_preset_instruction=pose_preset_instruction,
    )
    variant_label = f"variant_{normalized_variant_index}_{variant_name}"
    transform_mode_used = "generate_from_reference" if effective_pose_variation_enabled else IMAGE_TRANSFORM_MODE

    result: dict[str, Any] = {
        "index": index,
        "input_image": input_image,
        "generated_image": "",
        "status": "failed",
        "error": "",
        "model": requested_model,
        "transform_mode": transform_mode_used,
        "variant_index": normalized_variant_index,
        "variant_name": variant_name,
        "pose_variation_enabled": int(effective_pose_variation_enabled),
        "pose_preset_name": pose_preset_name if effective_pose_variation_enabled else "",
    }

    try:
        original_bytes = _read_input_bytes(item)
        vector_png_bytes, used_model = _vectorize_image_with_openai(
            original_bytes,
            requested_model=requested_model,
            prompt_text=variant_prompt,
            variant_name=variant_name,
            allow_pose_variation=effective_pose_variation_enabled,
            pose_variation_clause=(
                f"For this variant, adjust pose/framing as: {pose_preset_name}. {pose_preset_instruction} "
                f"Pose strength is {effective_pose_strength}. Head & shoulders only, square crop, centered, no extreme angles."
                if effective_pose_variation_enabled
                else None
            ),
        )
        generated_url = _upload_png_to_cloudinary(vector_png_bytes, job_id, index)

        result.update(
            {
                "generated_image": generated_url,
                "status": "success",
                "error": "",
                "model": used_model,
                "transform_mode": transform_mode_used,
                "variant_index": normalized_variant_index,
                "variant_name": variant_name,
                "pose_variation_enabled": int(effective_pose_variation_enabled),
                "pose_preset_name": pose_preset_name if effective_pose_variation_enabled else "",
            }
        )
        logger.info(
            "Image vectorization completed",
            extra={
                "job_id": job_id,
                "index": index,
                "input_image": input_image,
                "requested_model": requested_model,
                "used_model": used_model,
                "transform_mode": transform_mode_used,
                "variants_count": variants_count,
                "variant_index": normalized_variant_index,
                "variant_name": variant_name,
                "pose_variation_enabled": int(effective_pose_variation_enabled),
                "pose_preset_name": pose_preset_name if effective_pose_variation_enabled else "",
            },
        )
    except Exception as exc:
        result["error"] = str(exc)
        logger.exception(
            "Image vectorization failed",
            extra={
                "job_id": job_id,
                "index": index,
                "input_image": input_image,
                "transform_mode": transform_mode_used,
                "variants_count": variants_count,
                "variant_index": normalized_variant_index,
                "variant_name": variant_name,
                "pose_variation_enabled": int(effective_pose_variation_enabled),
                "pose_preset_name": pose_preset_name if effective_pose_variation_enabled else "",
                "error": str(exc),
            },
        )

    success = result["status"] == "success"
    increment_job_progress(job_id, success=success)
    store_job_result(job_id, result)
    try:
        refresh_live_result_csv(job_id)
    except Exception as exc:
        logger.warning(
            "Failed to refresh live result CSV",
            extra={"job_id": job_id, "index": index, "error": str(exc)},
        )
    if not success:
        append_job_error(job_id, f"{input_image} [{variant_label}]", result["error"] or "Unknown error")

    return result


def finalize_job(results: list[dict[str, Any]], job_id: str) -> dict[str, Any]:
    try:
        persisted_results, _ = read_job_results(job_id, limit=None)
        normalized_results: list[dict[str, Any]] = list(persisted_results)
        if not normalized_results:
            for record in results or []:
                if isinstance(record, dict):
                    normalized_results.append(record)
            normalized_results.sort(key=lambda row: int(row.get("index", 0)))

        csv_rows = build_result_csv_rows(normalized_results)

        csv_path = write_result_csv(job_id, csv_rows)
        archived_csv_path = write_archived_result_csv(job_id, csv_rows)
        json_path = write_result_json(job_id, normalized_results)

        update_job_meta(
            job_id,
            {
                "status": "completed",
                "completed_at": utcnow_iso(),
                "result_csv_path": str(csv_path),
                "archived_result_csv_path": str(archived_csv_path),
                "result_json_path": str(json_path),
            },
        )

        logger.info(
            "Bulk job finalized",
            extra={
                "job_id": job_id,
                "rows": len(csv_rows),
                "csv_path": str(csv_path),
                "archived_csv_path": str(archived_csv_path),
            },
        )
        return {
            "job_id": job_id,
            "rows": len(csv_rows),
            "result_csv_path": str(csv_path),
            "archived_result_csv_path": str(archived_csv_path),
        }
    except Exception as exc:
        append_job_error(job_id, "__finalize__", str(exc))
        update_job_meta(job_id, {"status": "failed", "failed_at": utcnow_iso(), "failure_reason": str(exc)})
        logger.exception("Failed to finalize job", extra={"job_id": job_id, "error": str(exc)})
        raise
