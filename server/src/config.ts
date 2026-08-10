import "dotenv/config";
import path from "node:path";

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
};

export const PORT = num(process.env.PORT, 8080);

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
export const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1-mini";
export const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE?.trim() || "1024x1024";
export const OPENAI_TIMEOUT_MS = num(process.env.OPENAI_TIMEOUT_SECONDS, 120) * 1000;

const VALID_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const rawQuality = (process.env.OPENAI_IMAGE_QUALITY ?? "medium").trim().toLowerCase();
export const OPENAI_IMAGE_QUALITY = VALID_QUALITIES.has(rawQuality) ? rawQuality : "medium";

const VALID_TRANSFORM_MODES = new Set(["edit", "generate_from_reference"]);
const rawMode = (process.env.IMAGE_TRANSFORM_MODE ?? "edit").trim().toLowerCase();
export const IMAGE_TRANSFORM_MODE = VALID_TRANSFORM_MODES.has(rawMode) ? rawMode : "edit";

export const IDENTITY_ANALYSIS_ENABLED = bool(process.env.IDENTITY_ANALYSIS_ENABLED, true);
export const IDENTITY_ANALYSIS_MODEL =
  process.env.IDENTITY_ANALYSIS_MODEL?.trim() || "gpt-4o-mini";

export const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME?.trim() ?? "";
export const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY?.trim() ?? "";
export const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET?.trim() ?? "";
export const CLOUDINARY_FOLDER_PREFIX =
  process.env.CLOUDINARY_FOLDER_PREFIX?.trim() || "vectorize_jobs";

export const EXTERNAL_MAX_RETRIES = num(process.env.EXTERNAL_MAX_RETRIES, 5);
export const DOWNLOAD_TIMEOUT_MS = num(process.env.DOWNLOAD_TIMEOUT_SECONDS, 30) * 1000;
export const DOWNLOAD_MAX_RETRIES = num(process.env.DOWNLOAD_MAX_RETRIES, 4);
export const MAX_DOWNLOAD_BYTES = num(process.env.MAX_DOWNLOAD_BYTES, 20 * 1024 * 1024);

/** Images processed concurrently. Set to 1 for strict one-by-one. */
export const WORKER_CONCURRENCY = Math.max(1, num(process.env.WORKER_CONCURRENCY, 6));

export const JOB_TTL_MS = num(process.env.JOB_TTL_SECONDS, 604800) * 1000;

/** Storage root — point at a mounted disk (e.g. /data) in the cloud. */
export const STORAGE_DIR = path.resolve(
  process.env.APP_STORAGE_DIR?.trim() || path.join(process.cwd(), "storage"),
);

export const CUSTOM_VECTORIZE_PROMPT = process.env.VECTORIZE_PROMPT?.trim() ?? "";

export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/** Shared access token. When set, every /api route requires it. */
export const APP_ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN?.trim() ?? "";

export const ALLOWED_IMAGE_MODELS = new Set(["gpt-image-1", "gpt-image-1-mini", "dall-e-2"]);
export const MIN_VARIANTS_COUNT = 1;
export const MAX_VARIANTS_COUNT = 10;
export const ALLOWED_POSE_STRENGTHS = new Set(["subtle", "medium"]);
export const MAX_STYLE_PROMPT_CHARS = 1000;

export const DALLE2_MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const DALLE2_MAX_PROMPT_CHARS = 1000;
export const MIN_IMAGE_SIDE = 256;
