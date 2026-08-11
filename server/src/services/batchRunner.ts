import fs from "node:fs";
import path from "node:path";

import { IMAGE_TRANSFORM_MODE, WORKER_CONCURRENCY } from "../config.js";
import { downloadImageBytes, isValidUrl, runWithConcurrency, toCsv } from "../lib/utils.js";
import type { BatchResultRow, ProcessItem } from "../types.js";
import { uploadPngToCloudinary, vectorizeImage } from "./imagePipeline.js";
import {
  appendError,
  BATCH_DIR,
  clearPendingItems,
  getBatch,
  getRemainingItems,
  getResults,
  loadPendingItems,
  recordResult,
  setBatchStatus,
  updateBatch,
} from "./batchStore.js";
import { buildVariantPrompt, getPosePreset } from "./prompts.js";

export const resultCsvPath = (): string => path.join(BATCH_DIR, "result.csv");

export const ensureBatchDirs = (): { dir: string; inputsDir: string } => {
  const inputsDir = path.join(BATCH_DIR, "inputs");
  fs.mkdirSync(inputsDir, { recursive: true });
  return { dir: BATCH_DIR, inputsDir };
};

const writeResultCsv = (): string => {
  const rows = getResults().map((row) => ({
    input_image: row.inputImage,
    generated_image: row.status === "success" ? row.generatedImage : "",
  }));

  const target = resultCsvPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, toCsv(rows, ["input_image", "generated_image"]), "utf8");
  return target;
};

const readInputBytes = async (item: ProcessItem): Promise<Buffer> => {
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

const processItem = async (item: ProcessItem): Promise<BatchResultRow> => {
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

  const row: BatchResultRow = {
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

    row.generatedImage = await uploadPngToCloudinary(bytes, "batch", item.index);
    row.status = "success";
    row.model = usedModel;
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    appendError(`${item.inputImage} [variant_${normalizedIndex}_${variantName}]`, row.error);
  }

  return row;
};

export const runBatch = async (items: ProcessItem[]): Promise<void> => {
  try {
    setBatchStatus("processing");
    updateBatch({ resultCsvPath: writeResultCsv() });

    if (items.length === 0) {
      updateBatch({ resultCsvPath: writeResultCsv() });
      setBatchStatus("completed");
      clearPendingItems();
      return;
    }

    await runWithConcurrency(items, WORKER_CONCURRENCY, async (item) => {
      let row: BatchResultRow;
      try {
        row = await processItem(item);
      } catch (error) {
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
        appendError(item.inputImage, row.error);
      }

      recordResult(row);
      try {
        writeResultCsv();
      } catch {
        /* non-fatal */
      }
      return row;
    });

    updateBatch({ resultCsvPath: writeResultCsv() });
    setBatchStatus("completed");
    clearPendingItems();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendError("__batch__", message);
    updateBatch({ failureReason: message });
    setBatchStatus("failed");
  }
};

export const runBatchInBackground = (items: ProcessItem[]): void => {
  void runBatch(items).catch((error) => {
    console.error(JSON.stringify({ level: "ERROR", message: "Batch failed", error: String(error) }));
  });
};

export const resumeBatchIfNeeded = (): void => {
  const batch = getBatch();
  if (!batch || batch.status !== "processing") return;

  const items = loadPendingItems();
  const remaining = getRemainingItems(items);
  if (remaining.length === 0) {
    setBatchStatus("completed");
    clearPendingItems();
    return;
  }

  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Resuming interrupted batch",
      remaining: remaining.length,
      total: batch.total,
    }),
  );
  runBatchInBackground(remaining);
};
