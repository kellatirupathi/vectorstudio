import type { JobStatus } from "../lib/api";

export const StatusPill = ({ status }: { status: JobStatus | "success" | "failed" }): JSX.Element => (
  <span className={`pill ${status}`}>
    <span className="pill-dot" />
    {status}
  </span>
);

export const ProgressBar = ({
  processed,
  total,
  status,
}: {
  processed: number;
  total: number;
  status: JobStatus;
}): JSX.Element => {
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const tone = status === "completed" ? "completed" : status === "failed" ? "failed" : "";

  return (
    <div className="progress-cell">
      <div className="progress-track">
        <div className={`progress-fill ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-text">
        {processed} / {total} · {percent}%
      </div>
    </div>
  );
};

export const StatCard = ({
  icon,
  tone,
  value,
  label,
}: {
  icon: string;
  tone: "total" | "ok" | "bad" | "img";
  value: number | string;
  label: string;
}): JSX.Element => (
  <div className="stat-card">
    <div className={`stat-icon ${tone}`} aria-hidden="true">
      {icon}
    </div>
    <div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  </div>
);

export const formatDateTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};
