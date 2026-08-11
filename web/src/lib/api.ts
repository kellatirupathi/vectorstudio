export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type JobSummary = {
  jobId: string;
  name: string;
  status: JobStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  createdAt: string;
  selectedModel: string;
  selectedVariantsCount: number;
};

export type JobResultRow = {
  index: number;
  inputImage: string;
  generatedImage: string;
  status: "success" | "failed";
  error: string;
  model: string;
  variantIndex: number;
  variantName: string;
};

export type JobError = {
  inputImage: string;
  errorMessage: string;
  timestamp: string;
};

export type JobDetail = JobSummary & {
  updatedAt: string;
  completedAt: string | null;
  failureReason: string | null;
  selectedTransformMode: string;
  selectedStylePromptEnabled: boolean;
  selectedPoseVariationEnabled: boolean;
  selectedPoseStrength: string;
  resultReady: boolean;
  errors: JobError[];
  totalErrors: number;
  resultRows: JobResultRow[];
  totalResultRows: number;
};

export type Stats = {
  totalJobs: number;
  succeeded: number;
  failed: number;
  images: number;
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

const formatRequestError = (error: unknown, response?: Response): string => {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return "Cannot reach the API. The server may be waking up or restarting — wait a moment and try again.";
  }
  if (response?.status === 404) {
    return "Job not found. The server likely restarted and cleared in-memory jobs — start a new batch.";
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
      formatRequestError(new Error((payload as { error?: string }).error ?? `Request failed (${response.status})`), response),
    );
  }
  return payload as T;
};

export const fetchStats = (): Promise<Stats> => request<Stats>("/api/jobs/stats");

export const fetchJobs = (): Promise<{ jobs: JobSummary[] }> =>
  request<{ jobs: JobSummary[] }>("/api/jobs");

export const fetchJob = (jobId: string): Promise<JobDetail> =>
  request<JobDetail>(`/api/jobs/${jobId}`);

export const createJob = async (formData: FormData): Promise<JobDetail> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/jobs`, {
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
      formatRequestError(new Error((payload as { error?: string }).error ?? "Failed to create job"), response),
    );
  }
  return payload as JobDetail;
};

export const downloadCsvUrl = (jobId: string): string => `${API_BASE}/api/jobs/${jobId}/result.csv`;

export const downloadCsv = async (jobId: string): Promise<void> => {
  const response = await fetch(downloadCsvUrl(jobId), { headers: authHeaders() });
  if (!response.ok) throw new Error("CSV is not ready yet");

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${jobId}_result.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
