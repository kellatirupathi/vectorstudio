import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { fetchJobs, fetchStats, type JobStatus, type JobSummary, type Stats } from "../lib/api";
import { formatDateTime, ProgressBar, StatCard, StatusPill } from "../components/ui";

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All status" },
  { value: "processing", label: "Processing" },
  { value: "queued", label: "Queued" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

export const DashboardPage = (): JSX.Element => {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [stats, setStats] = useState<Stats>({ totalJobs: 0, succeeded: 0, failed: 0, images: 0 });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [jobsPayload, statsPayload] = await Promise.all([fetchJobs(), fetchStats()]);
      setJobs(jobsPayload.jobs);
      setStats(statsPayload);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const visibleJobs = useMemo(() => {
    const term = search.trim().toLowerCase();
    return jobs.filter((job) => {
      const matchesStatus = statusFilter === "all" || job.status === statusFilter;
      const matchesTerm =
        !term || job.name.toLowerCase().includes(term) || job.jobId.toLowerCase().includes(term);
      return matchesStatus && matchesTerm;
    });
  }, [jobs, search, statusFilter]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Jobs</h1>
          <p className="page-sub">Bulk vector-style image generation jobs</p>
        </div>
        <button type="button" className="btn" onClick={() => navigate("/new")}>
          <span aria-hidden="true">+</span> New Job
        </button>
      </div>

      <div className="stat-grid">
        <StatCard icon="▦" tone="total" value={stats.totalJobs} label="Total Jobs" />
        <StatCard icon="✓" tone="ok" value={stats.succeeded} label="Successful" />
        <StatCard icon="✕" tone="bad" value={stats.failed} label="Failed" />
        <StatCard icon="✦" tone="img" value={stats.images} label="Images" />
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      <div className="toolbar">
        <div className="search-wrap">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            className="input"
            placeholder="Search jobs by name or ID..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <select
          className="select"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        {visibleJobs.length === 0 ? (
          <div className="empty-state">
            <h4>{loading ? "Loading jobs…" : "No jobs yet"}</h4>
            <p>
              {loading
                ? "Fetching the latest job list."
                : jobs.length > 0
                  ? "No jobs match your filters."
                  : "Start your first bulk vectorize job to see it here."}
            </p>
            {!loading && jobs.length === 0 ? (
              <button type="button" className="btn" onClick={() => navigate("/new")}>
                Create a job
              </button>
            ) : null}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Success</th>
                  <th>Failed</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {visibleJobs.map((job) => (
                  <tr key={job.jobId}>
                    <td>
                      <Link to={`/jobs/${job.jobId}`} className="cell-title link">
                        {job.name}
                      </Link>
                      <div className="cell-sub">
                        {job.selectedModel} · {job.selectedVariantsCount} variant
                        {job.selectedVariantsCount === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td>
                      <StatusPill status={job.status as JobStatus} />
                    </td>
                    <td>
                      <ProgressBar
                        processed={job.processed}
                        total={job.total}
                        status={job.status as JobStatus}
                      />
                    </td>
                    <td className="num ok">{job.succeeded}</td>
                    <td className="num bad">{job.failed}</td>
                    <td className="cell-sub">{formatDateTime(job.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
