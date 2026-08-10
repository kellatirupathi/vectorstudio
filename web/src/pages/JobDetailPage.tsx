import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { downloadCsv, fetchJob, type JobDetail } from "../lib/api";
import { formatDateTime, ProgressBar, StatCard, StatusPill } from "../components/ui";

export const JobDetailPage = (): JSX.Element => {
  const { jobId = "" } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setJob(await fetchJob(jobId));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (job && (job.status === "completed" || job.status === "failed")) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [job, load]);

  const handleDownload = async (): Promise<void> => {
    setDownloading(true);
    try {
      await downloadCsv(jobId);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    } finally {
      setDownloading(false);
    }
  };

  if (error && !job) {
    return (
      <div className="page">
        <Link to="/" className="back-link">
          ← Back to jobs
        </Link>
        <div className="alert error">{error}</div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="page">
        <Link to="/" className="back-link">
          ← Back to jobs
        </Link>
        <div className="card">
          <div className="empty-state">
            <h4>Loading job…</h4>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <Link to="/" className="back-link">
        ← Back to jobs
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">{job.name}</h1>
          <p className="page-sub">
            <span style={{ fontFamily: "var(--mono)", fontSize: ".82rem" }}>{job.jobId}</span>
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <StatusPill status={job.status} />
          <button
            type="button"
            className="btn btn-success"
            disabled={!job.resultReady || downloading}
            onClick={() => void handleDownload()}
          >
            {downloading ? "Preparing…" : "⬇ Download CSV"}
          </button>
        </div>
      </div>

      {error ? <div className="alert error">{error}</div> : null}
      {job.failureReason ? <div className="alert error">{job.failureReason}</div> : null}

      <div className="stat-grid">
        <StatCard icon="▦" tone="total" value={job.total} label="Total Images" />
        <StatCard icon="✓" tone="ok" value={job.succeeded} label="Successful" />
        <StatCard icon="✕" tone="bad" value={job.failed} label="Failed" />
        <StatCard icon="◷" tone="img" value={job.processed} label="Processed" />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">Progress</h3>
            <p className="card-sub">Updates automatically while the job runs</p>
          </div>
        </div>
        <div className="card-body">
          <ProgressBar processed={job.processed} total={job.total} status={job.status} />
        </div>
      </div>

      <div className="detail-grid" style={{ marginTop: 18 }}>
        <div className="meta-item">
          <div className="meta-label">Model</div>
          <div className="meta-value">{job.selectedModel}</div>
        </div>
        <div className="meta-item">
          <div className="meta-label">Variants</div>
          <div className="meta-value">{job.selectedVariantsCount}</div>
        </div>
        <div className="meta-item">
          <div className="meta-label">Mode</div>
          <div className="meta-value">{job.selectedTransformMode}</div>
        </div>
        <div className="meta-item">
          <div className="meta-label">Pose</div>
          <div className="meta-value">
            {job.selectedPoseVariationEnabled ? `On (${job.selectedPoseStrength})` : "Off"}
          </div>
        </div>
        <div className="meta-item">
          <div className="meta-label">Prompt</div>
          <div className="meta-value">{job.selectedStylePromptEnabled ? "Custom" : "Default"}</div>
        </div>
        <div className="meta-item">
          <div className="meta-label">Created</div>
          <div className="meta-value">{formatDateTime(job.createdAt)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">Results</h3>
            <p className="card-sub">{job.totalResultRows} rows</p>
          </div>
        </div>
        {job.resultRows.length === 0 ? (
          <div className="empty-state">
            <h4>No results yet</h4>
            <p>Rows appear here as each image finishes.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Input</th>
                  <th>Status</th>
                  <th>Variant</th>
                  <th>Output</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {job.resultRows.map((row) => (
                  <tr key={row.index}>
                    <td className="num">{row.index + 1}</td>
                    <td>
                      <div className="truncate" title={row.inputImage}>
                        {row.inputImage}
                      </div>
                    </td>
                    <td>
                      <StatusPill status={row.status} />
                    </td>
                    <td className="cell-sub">
                      #{row.variantIndex} {row.variantName}
                    </td>
                    <td>
                      {row.generatedImage ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <img className="thumb" src={row.generatedImage} alt="" loading="lazy" />
                          <a
                            className="link"
                            href={row.generatedImage}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            Open ↗
                          </a>
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <div className="truncate" title={row.error} style={{ color: "var(--danger)" }}>
                        {row.error || "—"}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">Errors</h3>
            <p className="card-sub">{job.totalErrors} recorded</p>
          </div>
        </div>
        <pre className={job.errors.length > 0 ? "mono-block error" : "mono-block"}>
          {job.errors.length === 0
            ? "No errors."
            : job.errors
                .map((item, index) => `${index + 1}. ${item.inputImage}\n   ${item.errorMessage}`)
                .join("\n")}
        </pre>
      </div>
    </div>
  );
};
