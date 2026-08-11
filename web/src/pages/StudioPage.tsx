import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ProgressBar, StatusPill } from "../components/ui";
import {
  createJob,
  downloadCsv,
  fetchJob,
  getAccessToken,
  setAccessToken,
  type JobDetail,
} from "../lib/api";

type InputMode = "upload" | "urls" | "csv";

const MODES: Array<{ value: InputMode; label: string }> = [
  { value: "upload", label: "Upload" },
  { value: "urls", label: "URLs" },
  { value: "csv", label: "CSV" },
];

const MAX_PROMPT_CHARS = 1000;

export const StudioPage = (): JSX.Element => {
  const imagesRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  const [tokenInput, setTokenInput] = useState(getAccessToken());
  const [tokenSaved, setTokenSaved] = useState(Boolean(getAccessToken()));

  const [mode, setMode] = useState<InputMode>("upload");
  const [urlsText, setUrlsText] = useState("");
  const [stylePrompt, setStylePrompt] = useState("");
  const [model, setModel] = useState("gpt-image-1-mini");
  const [variantsCount, setVariantsCount] = useState("1");
  const [poseVariation, setPoseVariation] = useState("0");
  const [poseStrength, setPoseStrength] = useState("subtle");
  const [imageCount, setImageCount] = useState(0);
  const [csvName, setCsvName] = useState("");

  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [downloading, setDownloading] = useState(false);

  const urlCount = useMemo(
    () => urlsText.split("\n").filter((line) => line.trim()).length,
    [urlsText],
  );

  const saveToken = (): void => {
    const trimmed = tokenInput.trim();
    setAccessToken(trimmed);
    setTokenSaved(Boolean(trimmed));
    setError("");
  };

  const loadJob = useCallback(async (jobId: string): Promise<void> => {
    try {
      setJob(await fetchJob(jobId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useEffect(() => {
    if (!activeJobId) return;
    void loadJob(activeJobId);
  }, [activeJobId, loadJob]);

  useEffect(() => {
    if (!activeJobId || !job) return;
    if (job.status === "completed" || job.status === "failed") return;
    const timer = setInterval(() => void loadJob(activeJobId), 2500);
    return () => clearInterval(timer);
  }, [activeJobId, job, loadJob]);

  const resetBatch = (): void => {
    setActiveJobId(null);
    setJob(null);
    setError("");
    setSubmitting(false);
    if (imagesRef.current) imagesRef.current.value = "";
    if (csvRef.current) csvRef.current.value = "";
    setImageCount(0);
    setCsvName("");
    setUrlsText("");
  };

  const submit = async (): Promise<void> => {
    setError("");
    if (!getAccessToken()) {
      setError("Add your access token first.");
      return;
    }

    const formData = new FormData();
    if (mode === "upload") {
      const files = Array.from(imagesRef.current?.files ?? []);
      if (files.length === 0) {
        setError("Select at least one image.");
        return;
      }
      files.forEach((file) => formData.append("images", file));
    } else if (mode === "urls") {
      if (!urlsText.trim()) {
        setError("Paste one or more image URLs.");
        return;
      }
      formData.append("urlsText", urlsText.trim());
    } else {
      const csvFile = csvRef.current?.files?.[0];
      if (!csvFile) {
        setError("Choose a CSV file.");
        return;
      }
      formData.append("csvFile", csvFile);
    }

    formData.append("stylePrompt", stylePrompt.trim());
    formData.append("model", model);
    formData.append("variantsCount", variantsCount);
    formData.append("poseVariation", poseVariation === "1" ? "true" : "false");
    formData.append("poseStrength", poseStrength);

    setSubmitting(true);
    try {
      const created = await createJob(formData);
      setActiveJobId(created.jobId);
      setJob(created);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownload = async (): Promise<void> => {
    if (!activeJobId) return;
    setDownloading(true);
    try {
      await downloadCsv(activeJobId);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
    } finally {
      setDownloading(false);
    }
  };

  const formLocked = Boolean(activeJobId && job && job.status !== "completed" && job.status !== "failed");

  return (
    <div className="studio">
      <header className="studio-header">
        <div className="studio-brand">
          <div className="studio-mark">V</div>
          <div>
            <h1 className="studio-title">Vector Studio</h1>
            <p className="studio-tagline">Bulk vector-style avatars from your photos</p>
          </div>
        </div>
      </header>

      <main className="studio-main">
        {!tokenSaved ? (
          <section className="panel panel-token">
            <h2 className="panel-heading">Access token</h2>
            <p className="panel-lead">Required to connect to the API. Ask your admin if you do not have one.</p>
            <div className="token-row">
              <input
                className="input"
                type="password"
                placeholder="Paste access token"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveToken();
                }}
              />
              <button type="button" className="btn" onClick={saveToken}>
                Save
              </button>
            </div>
          </section>
        ) : null}

        {error ? <div className="alert error">{error}</div> : null}

        <section className="panel">
          <div className="mode-tabs">
            {MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={mode === option.value ? "mode-tab active" : "mode-tab"}
                disabled={formLocked}
                onClick={() => setMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {mode === "upload" ? (
            <div className="field">
              <label className="label" htmlFor="images">
                Images
              </label>
              <input
                id="images"
                ref={imagesRef}
                className="file-input"
                type="file"
                accept="image/*"
                multiple
                disabled={formLocked}
                onChange={(event) => setImageCount(event.target.files?.length ?? 0)}
              />
              <p className="hint">
                {imageCount === 0
                  ? "Select one or more photos."
                  : `${imageCount} file${imageCount === 1 ? "" : "s"} selected.`}
              </p>
            </div>
          ) : null}

          {mode === "urls" ? (
            <div className="field">
              <label className="label" htmlFor="urls">
                Image URLs
              </label>
              <textarea
                id="urls"
                className="textarea"
                placeholder={"https://example.com/photo-1.jpg\nhttps://example.com/photo-2.jpg"}
                value={urlsText}
                disabled={formLocked}
                onChange={(event) => setUrlsText(event.target.value)}
              />
              <p className="hint">{urlCount} URL{urlCount === 1 ? "" : "s"} · one per line</p>
            </div>
          ) : null}

          {mode === "csv" ? (
            <div className="field">
              <label className="label" htmlFor="csv">
                CSV file
              </label>
              <input
                id="csv"
                ref={csvRef}
                className="file-input"
                type="file"
                accept=".csv,text/csv"
                disabled={formLocked}
                onChange={(event) => setCsvName(event.target.files?.[0]?.name ?? "")}
              />
              <p className="hint">
                {csvName || "Column input_image_url, or links in the first column."}
              </p>
            </div>
          ) : null}

          <div className="settings-row">
            <div className="field compact">
              <label className="label" htmlFor="model">
                Model
              </label>
              <select
                id="model"
                className="select"
                value={model}
                disabled={formLocked}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="gpt-image-1">gpt-image-1</option>
                <option value="gpt-image-1-mini">gpt-image-1-mini</option>
                <option value="dall-e-2">dall-e-2</option>
              </select>
            </div>
            <div className="field compact">
              <label className="label" htmlFor="variants">
                Variants
              </label>
              <select
                id="variants"
                className="select"
                value={variantsCount}
                disabled={formLocked}
                onChange={(event) => setVariantsCount(event.target.value)}
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map((value) => (
                  <option key={value} value={String(value)}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="field compact">
              <label className="label" htmlFor="pose">
                Pose
              </label>
              <select
                id="pose"
                className="select"
                value={poseVariation}
                disabled={formLocked}
                onChange={(event) => setPoseVariation(event.target.value)}
              >
                <option value="0">Keep pose</option>
                <option value="1">Vary pose</option>
              </select>
            </div>
            <div className="field compact">
              <label className="label" htmlFor="pose-strength">
                Strength
              </label>
              <select
                id="pose-strength"
                className="select"
                value={poseStrength}
                disabled={formLocked || poseVariation !== "1"}
                onChange={(event) => setPoseStrength(event.target.value)}
              >
                <option value="subtle">Subtle</option>
                <option value="medium">Medium</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="style-prompt">
              Style prompt <span className="label-optional">optional</span>
            </label>
            <textarea
              id="style-prompt"
              className="textarea small"
              maxLength={MAX_PROMPT_CHARS}
              placeholder="Leave empty for the default vector avatar style."
              value={stylePrompt}
              disabled={formLocked}
              onChange={(event) => setStylePrompt(event.target.value)}
            />
          </div>

          <div className="actions-row">
            {!formLocked ? (
              <button
                type="button"
                className="btn btn-lg"
                disabled={submitting}
                onClick={() => void submit()}
              >
                {submitting ? "Starting…" : "Start vectorizing"}
              </button>
            ) : null}
            {job && (job.status === "completed" || job.status === "failed") ? (
              <button type="button" className="btn btn-ghost" onClick={resetBatch}>
                New batch
              </button>
            ) : null}
          </div>
        </section>

        {job ? (
          <section className="panel panel-results">
            <div className="results-head">
              <div>
                <h2 className="panel-heading">Progress</h2>
                <StatusPill status={job.status} />
              </div>
              <button
                type="button"
                className="btn btn-success btn-sm"
                disabled={!job.resultReady || downloading}
                onClick={() => void handleDownload()}
              >
                {downloading ? "Preparing…" : "Download CSV"}
              </button>
            </div>

            <ProgressBar processed={job.processed} total={job.total} status={job.status} />

            {job.failureReason ? <div className="alert error">{job.failureReason}</div> : null}

            {job.resultRows.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.resultRows.map((row) => (
                      <tr key={row.index}>
                        <td>
                          <span className="truncate" title={row.inputImage}>
                            {row.inputImage}
                          </span>
                        </td>
                        <td>
                          {row.generatedImage ? (
                            <div className="output-cell">
                              <img className="thumb" src={row.generatedImage} alt="" loading="lazy" />
                              <a
                                className="link"
                                href={row.generatedImage}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                Open
                              </a>
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          <StatusPill status={row.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="hint center">Results appear here as each image finishes.</p>
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
};
