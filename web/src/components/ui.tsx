import type { BatchStatus } from "../lib/api";

export const StatusPill = ({ status }: { status: BatchStatus | "success" | "failed" }): JSX.Element => (
  <span className={`pill ${status}`}>{status}</span>
);

export const ProgressBar = ({
  processed,
  total,
  status,
}: {
  processed: number;
  total: number;
  status: BatchStatus;
}): JSX.Element => {
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const tone = status === "completed" ? "completed" : status === "failed" ? "failed" : "";

  return (
    <div className="progress-block">
      <div className="progress-track">
        <div className={`progress-fill ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="progress-label">
        {processed} of {total} images · {percent}%
      </p>
    </div>
  );
};
