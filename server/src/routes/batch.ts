import fs from "node:fs";
import path from "node:path";

import { Router } from "express";
import multer from "multer";

import {
  ALLOWED_IMAGE_MODELS,
  ALLOWED_POSE_STRENGTHS,
  IMAGE_TRANSFORM_MODE,
  MAX_STYLE_PROMPT_CHARS,
  MAX_VARIANTS_COUNT,
  MIN_VARIANTS_COUNT,
  OPENAI_IMAGE_MODEL,
} from "../config.js";
import { parseInputLinksCsv, parseUrlsText, sanitizeFilename } from "../lib/utils.js";
import { ensureBatchDirs, resultCsvPath, runBatchInBackground } from "../services/batchRunner.js";
import {
  clearBatch,
  createBatch,
  getBatch,
  getResults,
  isBatchActive,
  savePendingItems,
} from "../services/batchStore.js";
import type { ProcessItem } from "../types.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const sampleVariants = (count: number): number[] => {
  const pool = Array.from({ length: MAX_VARIANTS_COUNT }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
};

const serializeBatch = () => {
  const batch = getBatch();
  if (!batch) {
    return {
      status: "idle" as const,
      total: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      resultReady: false,
      resultRows: [] as ReturnType<typeof getResults>,
      errors: [],
      totalErrors: 0,
    };
  }

  const rows = getResults();
  const csvPath = batch.resultCsvPath ?? resultCsvPath();
  return {
    status: batch.status,
    total: batch.total,
    processed: batch.processed,
    succeeded: batch.succeeded,
    failed: batch.failed,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    completedAt: batch.completedAt ?? null,
    failureReason: batch.failureReason ?? null,
    selectedModel: batch.selectedModel,
    selectedVariantsCount: batch.selectedVariantsCount,
    selectedTransformMode: batch.selectedTransformMode,
    selectedStylePromptEnabled: batch.selectedStylePromptEnabled,
    selectedPoseVariationEnabled: batch.selectedPoseVariationEnabled,
    selectedPoseStrength: batch.selectedPoseStrength,
    resultReady: Boolean(batch.resultCsvPath && fs.existsSync(csvPath)),
    errors: batch.errors.slice(-50),
    totalErrors: batch.errors.length,
    resultRows: rows,
    totalResultRows: batch.results.size,
  };
};

router.get("/", (_req, res) => {
  res.json(serializeBatch());
});

router.delete("/", (_req, res) => {
  if (isBatchActive()) {
    res.status(409).json({ error: "A batch is still running. Wait for it to finish." });
    return;
  }
  clearBatch();
  res.json({ status: "idle" });
});

router.post(
  "/",
  upload.fields([
    { name: "images", maxCount: 5000 },
    { name: "csvFile", maxCount: 1 },
  ]),
  async (req, res) => {
    if (isBatchActive()) {
      res.status(409).json({ error: "A batch is already running. Wait for it to finish." });
      return;
    }

    clearBatch();

    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const body = req.body as Record<string, string>;

    const selectedModel = (body.model ?? "").trim() || OPENAI_IMAGE_MODEL;
    if (!ALLOWED_IMAGE_MODELS.has(selectedModel)) {
      res.status(400).json({
        error: `Invalid model. Allowed models: ${[...ALLOWED_IMAGE_MODELS].sort().join(", ")}`,
      });
      return;
    }

    const variantsCount = Number(body.variantsCount ?? 1);
    if (
      !Number.isInteger(variantsCount) ||
      variantsCount < MIN_VARIANTS_COUNT ||
      variantsCount > MAX_VARIANTS_COUNT
    ) {
      res.status(400).json({
        error: `Invalid variantsCount. Allowed range: ${MIN_VARIANTS_COUNT}-${MAX_VARIANTS_COUNT}`,
      });
      return;
    }

    const stylePrompt = (body.stylePrompt ?? "").trim();
    if (stylePrompt.length > MAX_STYLE_PROMPT_CHARS) {
      res
        .status(400)
        .json({ error: `stylePrompt is too long. Max length is ${MAX_STYLE_PROMPT_CHARS} characters.` });
      return;
    }

    const poseStrength = (body.poseStrength ?? "subtle").trim().toLowerCase();
    if (!ALLOWED_POSE_STRENGTHS.has(poseStrength)) {
      res.status(400).json({
        error: `Invalid poseStrength. Allowed values: ${[...ALLOWED_POSE_STRENGTHS].sort().join(", ")}`,
      });
      return;
    }
    const poseVariationEnabled = String(body.poseVariation ?? "false").toLowerCase() === "true";

    const { inputsDir } = ensureBatchDirs();

    type BaseItem = Omit<ProcessItem, "variantIndex" | "variantsCount" | "index"> & { index: number };
    const baseItems: BaseItem[] = [];
    let counter = 0;

    for (const file of files.images ?? []) {
      const originalName = sanitizeFilename(file.originalname || `uploaded_${counter}.png`);
      if (file.size <= 0) {
        baseItems.push({
          index: counter,
          inputImage: originalName,
          source: "invalid_upload",
          model: selectedModel,
          stylePrompt,
          poseVariationEnabled,
          poseStrength,
        });
      } else {
        const localName = `${String(counter).padStart(6, "0")}_${originalName}`;
        const localPath = path.join(inputsDir, localName);
        fs.writeFileSync(localPath, file.buffer);
        baseItems.push({
          index: counter,
          inputImage: originalName,
          source: "upload",
          localPath,
          model: selectedModel,
          stylePrompt,
          poseVariationEnabled,
          poseStrength,
        });
      }
      counter += 1;
    }

    for (const rawUrl of parseUrlsText(body.urlsText ?? "")) {
      baseItems.push({
        index: counter,
        inputImage: rawUrl,
        source: "url",
        url: rawUrl,
        model: selectedModel,
        stylePrompt,
        poseVariationEnabled,
        poseStrength,
      });
      counter += 1;
    }

    const csvFile = files.csvFile?.[0];
    if (csvFile && csvFile.buffer.byteLength > 0) {
      let csvUrls: string[];
      try {
        csvUrls = parseInputLinksCsv(csvFile.buffer);
      } catch (error) {
        res.status(400).json({ error: String(error) });
        return;
      }
      for (const rawUrl of csvUrls) {
        baseItems.push({
          index: counter,
          inputImage: rawUrl,
          source: "url",
          url: rawUrl,
          model: selectedModel,
          stylePrompt,
          poseVariationEnabled,
          poseStrength,
        });
        counter += 1;
      }
    }

    if (baseItems.length === 0) {
      res.status(400).json({ error: "No inputs provided. Add files, URLs, or a CSV." });
      return;
    }

    const items: ProcessItem[] = [];
    let expandedIndex = 0;
    for (const base of baseItems) {
      const variantIndexes =
        base.source === "url"
          ? sampleVariants(variantsCount)
          : Array.from({ length: variantsCount }, (_, i) => i + 1);

      for (const variantIndex of variantIndexes) {
        items.push({ ...base, index: expandedIndex, variantIndex, variantsCount });
        expandedIndex += 1;
      }
    }

    createBatch({
      total: items.length,
      selectedModel,
      selectedVariantsCount: variantsCount,
      selectedTransformMode: poseVariationEnabled ? "generate_from_reference" : IMAGE_TRANSFORM_MODE,
      selectedStylePromptEnabled: Boolean(stylePrompt),
      selectedPoseVariationEnabled: poseVariationEnabled,
      selectedPoseStrength: poseStrength,
    });

    savePendingItems(items);
    runBatchInBackground(items);
    res.status(201).json(serializeBatch());
  },
);

router.get("/result.csv", (_req, res) => {
  const batch = getBatch();
  if (!batch) {
    res.status(404).json({ error: "No batch results yet." });
    return;
  }

  const target = batch.resultCsvPath ?? resultCsvPath();
  if (!fs.existsSync(target)) {
    res.status(409).json({ error: "Result CSV is not ready yet" });
    return;
  }
  res.download(target, "vector_results.csv");
});

export default router;
