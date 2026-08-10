export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type ItemSource = "upload" | "url" | "invalid_upload";

export type JobItem = {
  index: number;
  inputImage: string;
  source: ItemSource;
  localPath?: string;
  url?: string;
  model: string;
  variantIndex: number;
  variantsCount: number;
  stylePrompt: string;
  poseVariationEnabled: boolean;
  poseStrength: string;
};

export type JobResultRow = {
  index: number;
  inputImage: string;
  generatedImage: string;
  status: "success" | "failed";
  error: string;
  model: string;
  transformMode: string;
  variantIndex: number;
  variantName: string;
  poseVariationEnabled: boolean;
  posePresetName: string;
};

export type JobError = {
  inputImage: string;
  errorMessage: string;
  timestamp: string;
};

export type JobRecord = {
  jobId: string;
  name: string;
  status: JobStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  selectedModel: string;
  selectedVariantsCount: number;
  selectedTransformMode: string;
  selectedStylePromptEnabled: boolean;
  selectedPoseVariationEnabled: boolean;
  selectedPoseStrength: string;
  resultCsvPath?: string;
  results: Map<number, JobResultRow>;
  errors: JobError[];
  expiresAt: number;
};
