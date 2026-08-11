/**
 * Single active batch — no job list, no job IDs exposed to the client.
 * State is persisted to disk so progress survives restarts.
 */
import fs from "node:fs";
import path from "node:path";

import { STORAGE_DIR } from "../config.js";
import { nowIso } from "../lib/utils.js";
import type { BatchError, BatchRecord, BatchResultRow, BatchStatus, ProcessItem } from "../types.js";

export const BATCH_DIR = path.join(STORAGE_DIR, "batch");
const STATE_PATH = path.join(BATCH_DIR, "state.json");
const ITEMS_PATH = path.join(BATCH_DIR, "items.json");

let current: BatchRecord | null = null;

type PersistedState = Omit<BatchRecord, "results"> & {
  results: BatchResultRow[];
};

const ensureDir = (): void => {
  fs.mkdirSync(BATCH_DIR, { recursive: true });
};

const persist = (): void => {
  if (!current) return;
  ensureDir();
  const payload: PersistedState = {
    ...current,
    results: [...current.results.values()].sort((a, b) => a.index - b.index),
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2), "utf8");
};

const hydrate = (raw: PersistedState): BatchRecord => ({
  ...raw,
  results: new Map(raw.results.map((row) => [row.index, row])),
});

export const loadBatchFromDisk = (): BatchRecord | null => {
  ensureDir();
  if (!fs.existsSync(STATE_PATH)) {
    current = null;
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as PersistedState;
    current = hydrate(raw);
    return current;
  } catch {
    current = null;
    return null;
  }
};

export const savePendingItems = (items: ProcessItem[]): void => {
  ensureDir();
  fs.writeFileSync(ITEMS_PATH, JSON.stringify(items, null, 2), "utf8");
};

export const loadPendingItems = (): ProcessItem[] => {
  if (!fs.existsSync(ITEMS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ITEMS_PATH, "utf8")) as ProcessItem[];
  } catch {
    return [];
  }
};

export const clearPendingItems = (): void => {
  if (fs.existsSync(ITEMS_PATH)) fs.unlinkSync(ITEMS_PATH);
};

export const getBatch = (): BatchRecord | null => current;

export const isBatchActive = (): boolean =>
  current?.status === "queued" || current?.status === "processing";

export const createBatch = (args: {
  total: number;
  selectedModel: string;
  selectedVariantsCount: number;
  selectedTransformMode: string;
  selectedStylePromptEnabled: boolean;
  selectedPoseVariationEnabled: boolean;
  selectedPoseStrength: string;
}): BatchRecord => {
  const timestamp = nowIso();
  current = {
    status: "queued",
    total: args.total,
    processed: 0,
    succeeded: 0,
    failed: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    selectedModel: args.selectedModel,
    selectedVariantsCount: args.selectedVariantsCount,
    selectedTransformMode: args.selectedTransformMode,
    selectedStylePromptEnabled: args.selectedStylePromptEnabled,
    selectedPoseVariationEnabled: args.selectedPoseVariationEnabled,
    selectedPoseStrength: args.selectedPoseStrength,
    results: new Map(),
    errors: [],
  };
  persist();
  return current;
};

export const clearBatch = (): void => {
  current = null;
  if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
  clearPendingItems();
};

export const updateBatch = (updates: Partial<BatchRecord>): void => {
  if (!current) return;
  Object.assign(current, updates);
  current.updatedAt = nowIso();
  persist();
};

export const setBatchStatus = (status: Exclude<BatchStatus, "idle">): void => {
  if (!current) return;
  current.status = status;
  if (status === "processing" && !current.startedAt) current.startedAt = nowIso();
  if (status === "completed" || status === "failed") current.completedAt = nowIso();
  current.updatedAt = nowIso();
  persist();
};

export const recordResult = (row: BatchResultRow): void => {
  if (!current) return;
  current.results.set(row.index, row);
  current.processed += 1;
  if (row.status === "success") current.succeeded += 1;
  else current.failed += 1;
  current.updatedAt = nowIso();
  persist();
};

export const appendError = (inputImage: string, errorMessage: string): void => {
  if (!current) return;
  current.errors.push({ inputImage, errorMessage, timestamp: nowIso() });
  current.updatedAt = nowIso();
  persist();
};

export const getResults = (): BatchResultRow[] => {
  if (!current) return [];
  return [...current.results.values()].sort((a, b) => a.index - b.index);
};

export const getRemainingItems = (items: ProcessItem[]): ProcessItem[] => {
  if (!current) return items;
  const done = new Set(current.results.keys());
  return items.filter((item) => !done.has(item.index));
};
