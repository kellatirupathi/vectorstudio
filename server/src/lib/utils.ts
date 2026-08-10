import { parse } from "csv-parse/sync";
import { DOWNLOAD_MAX_RETRIES, DOWNLOAD_TIMEOUT_MS, MAX_DOWNLOAD_BYTES } from "../config.js";

export const nowIso = (): string => new Date().toISOString();

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const FILENAME_SANITIZE_RE = /[^A-Za-z0-9._-]+/g;

export const sanitizeFilename = (filename: string, fallback = "input_image"): string => {
  const base = (filename ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  if (!base) return fallback;
  let sanitized = base.replace(FILENAME_SANITIZE_RE, "_").replace(/^[._]+|[._]+$/g, "");
  if (!sanitized) sanitized = fallback;
  return sanitized.slice(0, 180);
};

export const isValidUrl = (value: string): boolean => {
  const candidate = (value ?? "").trim();
  if (!candidate) return false;
  try {
    const parsed = new URL(candidate);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.host);
  } catch {
    return false;
  }
};

export const parseUrlsText = (urlsText: string): string[] =>
  (urlsText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

export const parseInputLinksCsv = (csvBuffer: Buffer): string[] => {
  let text = csvBuffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = parse(text, { relax_column_count: true, skip_empty_lines: true }) as string[][];
  if (rows.length === 0) return [];

  const firstRow = rows[0].map((cell) => (cell ?? "").trim());
  const headerIndex = firstRow.findIndex((value) => value.toLowerCase() === "input_image_url");

  if (headerIndex >= 0) {
    return rows
      .slice(1)
      .map((row) => (row[headerIndex] ?? "").trim())
      .filter(Boolean);
  }

  const startIndex = isValidUrl(firstRow[0] ?? "") ? 0 : 1;
  return rows
    .slice(startIndex)
    .map((row) => (row[0] ?? "").trim())
    .filter(Boolean);
};

/** Retry with exponential backoff and jitter. Mirrors the Python helper. */
export const retryWithBackoff = async <T>(
  operation: () => Promise<T>,
  options: {
    isRetriable: (error: unknown) => boolean;
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterMs?: number;
    operationName?: string;
  },
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const jitterMs = options.jitterMs ?? 250;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!options.isRetriable(error) || attempt === maxAttempts) break;

      const delay =
        Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) + Math.random() * jitterMs;
      console.warn(
        JSON.stringify({
          level: "WARN",
          message: "Retrying external operation",
          operation: options.operationName ?? "operation",
          attempt,
          maxAttempts,
          delayMs: Math.round(delay),
          error: String(error),
        }),
      );
      await sleep(delay);
    }
  }
  throw lastError;
};

const downloadOnce = async (url: string): Promise<Buffer> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Image is too large (>${MAX_DOWNLOAD_BYTES} bytes).`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Image is too large (>${MAX_DOWNLOAD_BYTES} bytes).`);
    }
    if (buffer.byteLength === 0) {
      throw new Error("Downloaded image is empty.");
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
};

export const downloadImageBytes = async (url: string): Promise<Buffer> =>
  retryWithBackoff(() => downloadOnce(url), {
    isRetriable: (error) => {
      const message = String(error);
      // Do not retry a payload that is simply too big.
      return !message.includes("too large");
    },
    maxAttempts: DOWNLOAD_MAX_RETRIES,
    baseDelayMs: 1000,
    maxDelayMs: 20000,
    operationName: "download_image",
  });

/** Run tasks with a bounded number in flight at once. */
export const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
};

export const toCsv = (rows: Array<Record<string, string>>, headers: string[]): string => {
  const escapeCell = (value: string): string => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCell(row[header] ?? "")).join(","));
  }
  return lines.join("\n");
};
