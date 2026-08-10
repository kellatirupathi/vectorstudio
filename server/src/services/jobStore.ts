/**
 * In-memory job store.
 *
 * NOTE: state lives in this process only. Jobs do not survive a restart or a
 * redeploy, and the app must run as a SINGLE instance — two instances would each
 * keep their own store and status polling would hit the wrong one.
 *
 * To add persistence later, implement the same functions against SQLite/Mongo;
 * nothing outside this module touches the Map directly.
 */
import { JOB_TTL_MS } from "../config.js";
import { nowIso } from "../lib/utils.js";
import type { JobError, JobRecord, JobResultRow, JobStatus } from "../types.js";

const jobs = new Map<string, JobRecord>();

const touch = (job: JobRecord): void => {
  job.updatedAt = nowIso();
  job.expiresAt = Date.now() + JOB_TTL_MS;
};

export const createJob = (args: {
  jobId: string;
  name: string;
  total: number;
  selectedModel: string;
  selectedVariantsCount: number;
  selectedTransformMode: string;
  selectedStylePromptEnabled: boolean;
  selectedPoseVariationEnabled: boolean;
  selectedPoseStrength: string;
}): JobRecord => {
  const timestamp = nowIso();
  const job: JobRecord = {
    jobId: args.jobId,
    name: args.name,
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
    results: new Map<number, JobResultRow>(),
    errors: [],
    expiresAt: Date.now() + JOB_TTL_MS,
  };
  jobs.set(args.jobId, job);
  return job;
};

export const getJob = (jobId: string): JobRecord | null => jobs.get(jobId) ?? null;

export const listJobs = (): JobRecord[] =>
  [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const updateJob = (jobId: string, updates: Partial<JobRecord>): void => {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, updates);
  touch(job);
};

export const setJobStatus = (jobId: string, status: JobStatus): void => {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = status;
  if (status === "processing" && !job.startedAt) job.startedAt = nowIso();
  if (status === "completed" || status === "failed") job.completedAt = nowIso();
  touch(job);
};

export const recordResult = (jobId: string, row: JobResultRow): void => {
  const job = jobs.get(jobId);
  if (!job) return;
  job.results.set(row.index, row);
  job.processed += 1;
  if (row.status === "success") job.succeeded += 1;
  else job.failed += 1;
  touch(job);
};

export const appendError = (jobId: string, inputImage: string, errorMessage: string): void => {
  const job = jobs.get(jobId);
  if (!job) return;
  const entry: JobError = { inputImage, errorMessage, timestamp: nowIso() };
  job.errors.push(entry);
  touch(job);
};

export const getResults = (jobId: string): JobResultRow[] => {
  const job = jobs.get(jobId);
  if (!job) return [];
  return [...job.results.values()].sort((a, b) => a.index - b.index);
};

/** Aggregate counters for the dashboard stat cards. */
export const getStats = (): {
  totalJobs: number;
  succeeded: number;
  failed: number;
  images: number;
} => {
  let succeeded = 0;
  let failed = 0;
  let images = 0;
  for (const job of jobs.values()) {
    succeeded += job.succeeded;
    failed += job.failed;
    images += job.total;
  }
  return { totalJobs: jobs.size, succeeded, failed, images };
};

const sweepExpiredJobs = (): void => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    // Never expire work still in flight.
    if (job.status === "queued" || job.status === "processing") continue;
    if (job.expiresAt <= now) jobs.delete(jobId);
  }
};

export const startSweeper = (): void => {
  const timer = setInterval(sweepExpiredJobs, 5 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
};
