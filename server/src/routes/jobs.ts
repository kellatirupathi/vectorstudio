import crypto from "node:crypto";
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
import { ensureJobDirs, resultCsvPath, runJobInBackground } from "../services/jobRunner.js";
import { createJob, getJob, getResults, getStats, listJobs } from "../services/jobStore.js";
import type { JobItem } from "../types.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

/** Random sample without replacement — mirrors Python's random.sample. */
const sampleVariants = (count: number): number[] => {
  const pool = Array.from({ length: MAX_VARIANTS_COUNT }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
};

const serializeJob = (jobId: string, includeRows: boolean) => {
  const job = getJob(jobId);
  if (!job) return null;

  const rows = includeRows ? getResults(jobId) : [];
  return {
    jobId: job.jobId,
    name: job.name,
    status: job.status,
    total: job.total,
    processed: job.processed,
    succeeded: job.succeeded,
    failed: job.failed,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt ?? null,
    failureReason: job.failureReason ?? null,
    selectedModel: job.selectedModel,
    selectedVariantsCount: job.selectedVariantsCount,
    selectedTransformMode: job.selectedTransformMode,
    selectedStylePromptEnabled: job.selectedStylePromptEnabled,
    selectedPoseVariationEnabled: job.selectedPoseVariationEnabled,
    selectedPoseStrength: job.selectedPoseStrength,
    resultReady: Boolean(job.resultCsvPath && fs.existsSync(job.resultCsvPath)),
    errors: job.errors.slice(-50),
    totalErrors: job.errors.length,
    resultRows: rows,
    totalResultRows: job.results.size,
  };
};

router.get("/stats", (_req, res) => {
  res.json(getStats());
});

router.get("/", (_req, res) => {
  res.json({
    jobs: listJobs().map((job) => ({
      jobId: job.jobId,
      name: job.name,
      status: job.status,
      total: job.total,
      processed: job.processed,
      succeeded: job.succeeded,
      failed: job.failed,
      createdAt: job.createdAt,
      selectedModel: job.selectedModel,
      selectedVariantsCount: job.selectedVariantsCount,
    })),
  });
});

router.post(
  "/",
  upload.fields([
    { name: "images", maxCount: 5000 },
    { name: "csvFile", maxCount: 1 },
  ]),
  async (req, res) => {
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

    const jobId = crypto.randomUUID();
    const { inputsDir } = ensureJobDirs(jobId);

    type BaseItem = Omit<JobItem, "variantIndex" | "variantsCount" | "index"> & { index: number };
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

    // Expand each input into one item per variant. URL/CSV inputs get randomized
    // variant assignment, matching the original pipeline's behaviour.
    const items: JobItem[] = [];
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

    const defaultName = `Batch ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    createJob({
      jobId,
      name: (body.name ?? "").trim() || defaultName,
      total: items.length,
      selectedModel,
      selectedVariantsCount: variantsCount,
      selectedTransformMode: poseVariationEnabled ? "generate_from_reference" : IMAGE_TRANSFORM_MODE,
      selectedStylePromptEnabled: Boolean(stylePrompt),
      selectedPoseVariationEnabled: poseVariationEnabled,
      selectedPoseStrength: poseStrength,
    });

    runJobInBackground(jobId, items);
    res.status(201).json(serializeJob(jobId, false));
  },
);

router.get("/:jobId", (req, res) => {
  const payload = serializeJob(req.params.jobId, true);
  if (!payload) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(payload);
});

router.get("/:jobId/result.csv", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const target = job.resultCsvPath ?? resultCsvPath(job.jobId);
  if (!fs.existsSync(target)) {
    res.status(409).json({ error: "Result CSV is not ready yet" });
    return;
  }
  res.download(target, `${job.jobId}_result.csv`);
});

export default router;
