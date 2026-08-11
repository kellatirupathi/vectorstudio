export type BatchStatus = "idle" | "queued" | "processing" | "completed" | "failed";

export type BatchResultRow = {
  index: number;
  inputImage: string;
  generatedImage: string;
  status: "success" | "failed";
  error: string;
  model: string;
  variantIndex: number;
  variantName: string;
};

export type BatchError = {
  inputImage: string;
  errorMessage: string;
  timestamp: string;
};

export type BatchState = {
  status: BatchStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  failureReason?: string | null;
  selectedModel?: string;
  selectedVariantsCount?: number;
  selectedTransformMode?: string;
  selectedStylePromptEnabled?: boolean;
  selectedPoseVariationEnabled?: boolean;
  selectedPoseStrength?: string;
  resultReady: boolean;
  errors: BatchError[];
  totalErrors: number;
  resultRows: BatchResultRow[];
  totalResultRows: number;
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

const TOKEN_KEY = "vectorstudio.accessToken";

export const getAccessToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setAccessToken = (token: string): void => {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
};

const authHeaders = (): Record<string, string> => {
  const token = getAccessToken();
  return token ? { "x-access-token": token } : {};
};

const formatRequestError = (error: unknown): string => {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return "Cannot reach the API. The server may be waking up — wait a moment and try again.";
  }
  if (error instanceof Error) return error.message;
  return String(error);
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new Error(formatRequestError(error));
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      formatRequestError(
        new Error((payload as { error?: string }).error ?? `Request failed (${response.status})`),
      ),
    );
  }
  return payload as T;
};

export const fetchBatch = (): Promise<BatchState> => request<BatchState>("/api/batch");

export const startBatch = async (formData: FormData): Promise<BatchState> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/batch`, {
      method: "POST",
      headers: authHeaders(),
      body: formData,
    });
  } catch (error) {
    throw new Error(formatRequestError(error));
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      formatRequestError(
        new Error((payload as { error?: string }).error ?? "Failed to start batch"),
      ),
    );
  }
  return payload as BatchState;
};

export const clearBatch = (): Promise<BatchState> =>
  request<BatchState>("/api/batch", { method: "DELETE" });

export const downloadCsv = async (): Promise<void> => {
  const response = await fetch(`${API_BASE}/api/batch/result.csv`, { headers: authHeaders() });
  if (!response.ok) throw new Error("CSV is not ready yet");

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "vector_results.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
