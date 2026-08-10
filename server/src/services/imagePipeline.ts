/**
 * Image pipeline — port of backend/tasks.py.
 *
 * Keeps the original's defensive behaviour against account/model differences:
 * unsupported request parameters (`quality`, `input_fidelity`, `response_format`)
 * and enforced model substitutions are detected from the 400 body and retried.
 */
import { v2 as cloudinary } from "cloudinary";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";

import {
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_FOLDER_PREFIX,
  DALLE2_MAX_INPUT_BYTES,
  EXTERNAL_MAX_RETRIES,
  IDENTITY_ANALYSIS_ENABLED,
  IDENTITY_ANALYSIS_MODEL,
  IMAGE_TRANSFORM_MODE,
  MIN_IMAGE_SIDE,
  OPENAI_API_KEY,
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGE_QUALITY,
  OPENAI_IMAGE_SIZE,
  OPENAI_TIMEOUT_MS,
} from "../config.js";
import { downloadImageBytes, retryWithBackoff } from "../lib/utils.js";
import {
  buildEditPrompt,
  buildGenerationPromptFromReference,
  clampPromptForModel,
  VECTORIZE_PROMPT,
} from "./prompts.js";

/** Signals a 4xx that must not be retried. */
export class NonRetriableOpenAIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetriableOpenAIError";
  }
}

let openaiClient: OpenAI | null = null;
let cloudinaryConfigured = false;

export const getOpenAIClient = (): OpenAI => {
  if (openaiClient) return openaiClient;
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required.");
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS });
  return openaiClient;
};

export const ensureCloudinaryConfig = (): void => {
  if (cloudinaryConfigured) return;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error(
      "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are required.",
    );
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  cloudinaryConfigured = true;
};

const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;

const isBadRequest = (error: unknown): boolean => statusOf(error) === 400;

const isRetriableOpenAIError = (error: unknown): boolean => {
  if (error instanceof NonRetriableOpenAIError) return false;
  const status = statusOf(error);
  if (status === undefined) return true; // network/timeout
  return status === 429 || status >= 500;
};

/** Extract the model name the API demands from a "Value must be 'x'" message. */
const extractRequiredModel = (message: string): string | null => {
  const match = /Value must be '([^']+)'/.exec(message);
  return match ? match[1].trim() : null;
};

/**
 * Normalize to PNG/RGBA under the 4 MB input limit, honouring EXIF rotation.
 * Downscales progressively when the encoded payload is still too large.
 */
export const normalizeInputImage = async (imageBytes: Buffer): Promise<Buffer> => {
  try {
    const base = sharp(imageBytes, { failOn: "none" }).rotate();
    const metadata = await base.metadata();

    let encoded = await base
      .clone()
      .ensureAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (encoded.byteLength <= DALLE2_MAX_INPUT_BYTES) return encoded;

    let width = metadata.width ?? 1024;
    let height = metadata.height ?? 1024;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      width = Math.max(Math.floor(width * 0.85), MIN_IMAGE_SIDE);
      height = Math.max(Math.floor(height * 0.85), MIN_IMAGE_SIDE);

      encoded = await sharp(imageBytes, { failOn: "none" })
        .rotate()
        .resize(width, height, { fit: "inside", kernel: "lanczos3" })
        .ensureAlpha()
        .png({ compressionLevel: 9 })
        .toBuffer();

      if (encoded.byteLength <= DALLE2_MAX_INPUT_BYTES) return encoded;
      if (width <= MIN_IMAGE_SIDE || height <= MIN_IMAGE_SIDE) break;
    }

    throw new Error("Input image is too large after normalization. Please use a smaller image.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("too large after normalization")) throw error;
    throw new Error(`Unable to process input image: ${String(error)}`);
  }
};

const extractImageBytesFromResponse = async (response: any): Promise<Buffer> => {
  const record = response?.data?.[0];
  if (!record) throw new Error("OpenAI image response is empty.");
  if (record.b64_json) return Buffer.from(record.b64_json, "base64");
  if (record.url) return downloadImageBytes(record.url);
  throw new Error("OpenAI image response did not contain image bytes.");
};

/** Identity fingerprint used by generate_from_reference mode. */
const describeReferenceIdentity = async (inputImageBytes: Buffer): Promise<string> => {
  const client = getOpenAIClient();
  const imageDataUrl = `data:image/png;base64,${inputImageBytes.toString("base64")}`;

  const systemPrompt =
    "You extract strict, immutable facial identity fingerprints for consistent portrait generation.\n" +
    "Output plain text only, compact, deterministic, and stable across repeated runs.\n" +
    "Never use subjective adjectives (e.g., handsome, beautiful, sharp).";

  const userPrompt =
    "Analyze this portrait and return one compact identity fingerprint line using this exact key order and format:\n" +
    "face_shape=...; jawline_chin=...; eye_shape_spacing_eyelid=...; eyebrow_thickness_curve=...; " +
    "nose_bridge_tip_nostril_width=...; lip_shape_upper_lower=...; beard_mustache_style_density_edges=...; " +
    "hairline_hairstyle_volume_parting=...; skin_tone_category=...; expression_head_angle=...\n" +
    "Rules:\n" +
    "- Include only immutable facial structure cues.\n" +
    "- Keep wording specific and concrete.\n" +
    "- Do NOT include attractiveness, beauty, or artistic terms.\n" +
    "- Do NOT include background, clothing, accessories, or lighting style.\n" +
    "- If unknown, use the word 'unknown'.\n" +
    "- Return exactly one plain-text line.";

  try {
    const description = await retryWithBackoff(
      async () => {
        const response = await client.chat.completions.create({
          model: IDENTITY_ANALYSIS_MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: userPrompt },
                { type: "image_url", image_url: { url: imageDataUrl } },
              ],
            },
          ],
        });
        return response.choices?.[0]?.message?.content ?? "";
      },
      {
        isRetriable: isRetriableOpenAIError,
        maxAttempts: EXTERNAL_MAX_RETRIES,
        baseDelayMs: 1000,
        maxDelayMs: 20000,
        operationName: "identity_analysis",
      },
    );

    return String(description).trim().slice(0, 500);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "WARN",
        message: "Identity analysis failed; proceeding with style prompt only",
        error: String(error),
      }),
    );
    return "";
  }
};

const vectorizeWithGenerate = async (
  promptText: string,
  requestedModel?: string,
): Promise<{ bytes: Buffer; usedModel: string }> => {
  const client = getOpenAIClient();
  let modelInUse = (requestedModel ?? "").trim() || OPENAI_IMAGE_MODEL;

  const request = async (): Promise<any> => {
    const payload: Record<string, unknown> = {
      model: modelInUse,
      prompt: clampPromptForModel(promptText, modelInUse),
      size: OPENAI_IMAGE_SIZE,
    };

    // gpt-image models already return base64; forcing response_format is rejected.
    if (!modelInUse.startsWith("gpt-image-1")) payload.response_format = "b64_json";
    else payload.output_format = "png";

    if (OPENAI_IMAGE_QUALITY) payload.quality = OPENAI_IMAGE_QUALITY;

    let qualityFallbackApplied = false;
    let modelFallbackApplied = false;
    let responseFormatFallbackApplied = false;

    for (;;) {
      try {
        return await client.images.generate(payload as any);
      } catch (error) {
        if (!isBadRequest(error)) throw error;
        const message = String(error);

        if (
          !responseFormatFallbackApplied &&
          message.includes("Unknown parameter: 'response_format'") &&
          "response_format" in payload
        ) {
          delete payload.response_format;
          responseFormatFallbackApplied = true;
          continue;
        }

        if (
          !qualityFallbackApplied &&
          (message.includes("Unknown parameter: 'quality'") ||
            (message.includes("quality") && message.includes("Invalid value"))) &&
          "quality" in payload
        ) {
          delete payload.quality;
          qualityFallbackApplied = true;
          continue;
        }

        if (!modelFallbackApplied && message.includes("Value must be") && message.includes("model")) {
          const requiredModel = extractRequiredModel(message);
          if (requiredModel && payload.model !== requiredModel) {
            payload.model = requiredModel;
            modelInUse = requiredModel;
            payload.prompt = clampPromptForModel(promptText, requiredModel);
            modelFallbackApplied = true;
            continue;
          }
        }
        throw error;
      }
    }
  };

  return retryWithBackoff(
    async () => {
      let response: any;
      try {
        response = await request();
      } catch (error) {
        const status = statusOf(error);
        if (status !== undefined && status < 500 && status !== 429) {
          throw new NonRetriableOpenAIError(String(error));
        }
        throw error;
      }
      return { bytes: await extractImageBytesFromResponse(response), usedModel: modelInUse };
    },
    {
      isRetriable: isRetriableOpenAIError,
      maxAttempts: EXTERNAL_MAX_RETRIES,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      operationName: "openai_image_generate",
    },
  );
};

const vectorizeWithEdit = async (
  inputImageBytes: Buffer,
  promptText: string,
  requestedModel?: string,
): Promise<{ bytes: Buffer; usedModel: string }> => {
  const client = getOpenAIClient();
  const preparedReference = await normalizeInputImage(inputImageBytes);
  let modelInUse = (requestedModel ?? "").trim() || OPENAI_IMAGE_MODEL;

  const request = async (): Promise<any> => {
    const payload: Record<string, unknown> = {
      model: modelInUse,
      prompt: clampPromptForModel(promptText, modelInUse),
      size: OPENAI_IMAGE_SIZE,
      output_format: "png",
      input_fidelity: "high",
    };

    if (OPENAI_IMAGE_QUALITY) payload.quality = OPENAI_IMAGE_QUALITY;

    let qualityFallbackApplied = false;
    let fidelityFallbackApplied = false;
    let modelFallbackApplied = false;

    for (;;) {
      try {
        // The file must be rebuilt per attempt; the stream is consumed on send.
        payload.image = await toFile(preparedReference, "input.png", { type: "image/png" });
        return await client.images.edit(payload as any);
      } catch (error) {
        if (!isBadRequest(error)) throw error;
        const message = String(error);
        const lower = message.toLowerCase();

        if (
          !fidelityFallbackApplied &&
          (lower.includes("unknown parameter: 'input_fidelity'") ||
            (lower.includes("input_fidelity") && lower.includes("invalid value")) ||
            (lower.includes("input_fidelity") && lower.includes("not supported")) ||
            lower.includes("invalid_input_fidelity_model")) &&
          "input_fidelity" in payload
        ) {
          delete payload.input_fidelity;
          fidelityFallbackApplied = true;
          continue;
        }

        if (
          !qualityFallbackApplied &&
          (message.includes("Unknown parameter: 'quality'") ||
            (message.includes("quality") && message.includes("Invalid value"))) &&
          "quality" in payload
        ) {
          delete payload.quality;
          qualityFallbackApplied = true;
          continue;
        }

        if (!modelFallbackApplied && message.includes("Value must be") && message.includes("model")) {
          const requiredModel = extractRequiredModel(message);
          if (requiredModel && payload.model !== requiredModel) {
            payload.model = requiredModel;
            modelInUse = requiredModel;
            payload.prompt = clampPromptForModel(promptText, requiredModel);
            modelFallbackApplied = true;
            continue;
          }
        }
        throw error;
      }
    }
  };

  return retryWithBackoff(
    async () => {
      let response: any;
      try {
        response = await request();
      } catch (error) {
        const status = statusOf(error);
        if (status !== undefined && status < 500 && status !== 429) {
          throw new NonRetriableOpenAIError(String(error));
        }
        throw error;
      }
      return { bytes: await extractImageBytesFromResponse(response), usedModel: modelInUse };
    },
    {
      isRetriable: isRetriableOpenAIError,
      maxAttempts: EXTERNAL_MAX_RETRIES,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      operationName: "openai_image_edit",
    },
  );
};

export const vectorizeImage = async (args: {
  inputImageBytes: Buffer;
  requestedModel?: string;
  promptText?: string;
  variantName?: string;
  allowPoseVariation?: boolean;
  poseVariationClause?: string | null;
}): Promise<{ bytes: Buffer; usedModel: string }> => {
  const basePrompt = (args.promptText || VECTORIZE_PROMPT).trim();

  if (IMAGE_TRANSFORM_MODE === "edit" && !args.allowPoseVariation) {
    return vectorizeWithEdit(
      args.inputImageBytes,
      buildEditPrompt(basePrompt, args.variantName),
      args.requestedModel,
    );
  }

  // Reference-based generation: analyze identity, then generate a fresh image.
  const preparedReference = await normalizeInputImage(args.inputImageBytes);
  const identityDescription = IDENTITY_ANALYSIS_ENABLED
    ? await describeReferenceIdentity(preparedReference)
    : "";

  const generationPrompt = buildGenerationPromptFromReference({
    identityDescription,
    basePromptText: basePrompt,
    variantName: args.variantName,
    poseVariationClause: args.allowPoseVariation ? args.poseVariationClause : null,
    techStyleEnabled: Boolean(args.allowPoseVariation),
  });

  return vectorizeWithGenerate(generationPrompt, args.requestedModel);
};

export const uploadPngToCloudinary = async (
  pngBytes: Buffer,
  jobId: string,
  index: number,
): Promise<string> => {
  ensureCloudinaryConfig();

  const folder = `${CLOUDINARY_FOLDER_PREFIX}/${jobId}`;
  const publicId = `vector_${String(index).padStart(6, "0")}`;

  return retryWithBackoff(
    () =>
      new Promise<string>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder, public_id: publicId, overwrite: true, resource_type: "image", format: "png" },
          (error, result) => {
            if (error) return reject(error);
            const secureUrl = result?.secure_url ?? result?.url;
            if (!secureUrl) return reject(new Error("Cloudinary did not return a public URL."));
            resolve(secureUrl);
          },
        );
        stream.end(pngBytes);
      }),
    {
      isRetriable: () => true,
      maxAttempts: EXTERNAL_MAX_RETRIES,
      baseDelayMs: 1000,
      maxDelayMs: 20000,
      operationName: "cloudinary_upload",
    },
  );
};
