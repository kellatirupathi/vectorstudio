export type BatchStatus = "queued" | "processing" | "completed" | "failed" | "idle";

export type ItemSource = "upload" | "url" | "invalid_upload";

export type ProcessItem = {
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

export type BatchResultRow = {
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

export type BatchError = {
  inputImage: string;
  errorMessage: string;
  timestamp: string;
};

export type BatchRecord = {
  status: Exclude<BatchStatus, "idle">;
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
  results: Map<number, BatchResultRow>;
  errors: BatchError[];
};

/** @deprecated use BatchStatus */
export type JobStatus = Exclude<BatchStatus, "idle">;

/** @deprecated use ProcessItem */
export type JobItem = ProcessItem;

/** @deprecated use BatchResultRow */
export type JobResultRow = BatchResultRow;

/** @deprecated use BatchError */
export type JobError = BatchError;
