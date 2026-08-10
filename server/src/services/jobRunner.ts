import fs from "node:fs";
import path from "node:path";

import { IMAGE_TRANSFORM_MODE, STORAGE_DIR, WORKER_CONCURRENCY } from "../config.js";
import { downloadImageBytes, isValidUrl, runWithConcurrency, toCsv } from "../lib/utils.js";
import type { JobItem, JobResultRow } from "../types.js";
import { uploadPngToCloudinary, vectorizeImage } from "./imagePipeline.js";
import { appendError, getResults, recordResult, setJobStatus, updateJob } from "./jobStore.js";
import { buildVariantPrompt, getPosePreset } from "./prompts.js";

export const jobDir = (jobId: string): string => path.join(STORAGE_DIR, "jobs", jobId);

export const ensureJobDirs = (jobId: string): { dir: string; inputsDir: string } => {
  const dir = jobDir(jobId);
  const inputsDir = path.join(dir, "inputs");
  fs.mkdirSync(inputsDir, { recursive: true });
  return { dir, inputsDir };
};

export const resultCsvPath = (jobId: string): string => path.join(jobDir(jobId), "result.csv");

const writeResultCsv = (jobId: string): string => {
  const rows = getResults(jobId).map((row) => ({
    input_image: row.inputImage,
    generated_image: row.status === "success" ? row.generatedImage : "",
  }));

  const target = resultCsvPath(jobId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toCsv(rows, ["input_image", "generated_image"]), "utf8");
  return target;
};

const readInputBytes = async (item: JobItem): Promise<Buffer> => {
  if (item.source === "invalid_upload") throw new Error("Uploaded file is empty.");

  if (item.source === "upload") {
    if (!item.localPath) throw new Error("Uploaded file path is missing.");
    if (!fs.existsSync(item.localPath)) throw new Error(`Uploaded file not found: ${item.localPath}`);
    const payload = fs.readFileSync(item.localPath);
    if (payload.byteLength === 0) throw new Error("Uploaded file is empty.");
    return payload;
  }

  if (item.source === "url") {
    const url = (item.url ?? "").trim();
    if (!isValidUrl(url)) throw new Error("Invalid image URL.");
    return downloadImageBytes(url);
  }

  throw new Error("Unsupported input source.");
};

const processItem = async (jobId: string, item: JobItem): Promise<JobResultRow> => {
  const posePreset = getPosePreset(item.variantIndex);
  const { normalizedIndex, variantName, promptText } = buildVariantPrompt({
    variantIndex: item.variantIndex,
    variantsCount: item.variantsCount,
    stylePromptOverride: item.stylePrompt,
    poseVariationEnabled: item.poseVariationEnabled,
    poseStrength: item.poseStrength,
    posePresetName: posePreset.name,
    posePresetInstruction: posePreset.instruction,
  });

  const transformModeUsed = item.poseVariationEnabled
    ? "generate_from_reference"
    : IMAGE_TRANSFORM_MODE;

  const row: JobResultRow = {
    index: item.index,
    inputImage: item.inputImage,
    generatedImage: "",
    status: "failed",
    error: "",
    model: item.model,
    transformMode: transformModeUsed,
    variantIndex: normalizedIndex,
    variantName,
    poseVariationEnabled: item.poseVariationEnabled,
    posePresetName: item.poseVariationEnabled ? posePreset.name : "",
  };

  try {
    const originalBytes = await readInputBytes(item);
    const { bytes, usedModel } = await vectorizeImage({
      inputImageBytes: originalBytes,
      requestedModel: item.model,
      promptText,
      variantName,
      allowPoseVariation: item.poseVariationEnabled,
      poseVariationClause: item.poseVariationEnabled
        ? `For this variant, adjust pose/framing as: ${posePreset.name}. ${posePreset.instruction} ` +
          `Pose strength is ${item.poseStrength}. Head & shoulders only, square crop, centered, no extreme angles.`
        : null,
    });

    row.generatedImage = await uploadPngToCloudinary(bytes, jobId, item.index);
    row.status = "success";
    row.model = usedModel;
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    appendError(jobId, `${item.inputImage} [variant_${normalizedIndex}_${variantName}]`, row.error);
  }

  return row;
};

/** Run the whole job. Resolves once every item is processed and the CSV written. */
export const runJob = async (jobId: string, items: JobItem[]): Promise<void> => {
  try {
    setJobStatus(jobId, "processing");
    updateJob(jobId, { resultCsvPath: writeResultCsv(jobId) });

    if (items.length === 0) {
      updateJob(jobId, { resultCsvPath: writeResultCsv(jobId) });
      setJobStatus(jobId, "completed");
      return;
    }

    await runWithConcurrency(items, WORKER_CONCURRENCY, async (item) => {
      let row: JobResultRow;
      try {
        row = await processItem(jobId, item);
      } catch (error) {
        // processItem handles its own failures; this guards against a crash so
        // one bad item cannot abort the remaining work.
        row = {
          index: item.index,
          inputImage: item.inputImage,
          generatedImage: "",
          status: "failed",
          error: String(error),
          model: item.model,
          transformMode: IMAGE_TRANSFORM_MODE,
          variantIndex: item.variantIndex,
          variantName: "",
          poseVariationEnabled: item.poseVariationEnabled,
          posePresetName: "",
        };
        appendError(jobId, item.inputImage, row.error);
      }

      recordResult(jobId, row);
      try {
        writeResultCsv(jobId); // keep the live CSV current
      } catch {
        /* non-fatal */
      }
      return row;
    });

    updateJob(jobId, { resultCsvPath: writeResultCsv(jobId) });
    setJobStatus(jobId, "completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendError(jobId, "__job__", message);
    updateJob(jobId, { failureReason: message });
    setJobStatus(jobId, "failed");
  }
};

/** Fire-and-forget wrapper so the HTTP request returns immediately. */
export const runJobInBackground = (jobId: string, items: JobItem[]): void => {
  void runJob(jobId, items).catch((error) => {
    console.error(
      JSON.stringify({ level: "ERROR", message: "Job thread failed", jobId, error: String(error) }),
    );
  });
};
