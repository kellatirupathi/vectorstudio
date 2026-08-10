import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { createJob } from "../lib/api";

type InputMode = "upload" | "urls" | "csv";

const MODES: Array<{ value: InputMode; label: string }> = [
  { value: "upload", label: "Upload Images" },
  { value: "urls", label: "Paste URLs" },
  { value: "csv", label: "Upload CSV" },
];

const MAX_PROMPT_CHARS = 1000;

export const NewJobPage = (): JSX.Element => {
  const navigate = useNavigate();
  const imagesRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<InputMode>("upload");
  const [name, setName] = useState("");
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

  const urlCount = useMemo(
    () => urlsText.split("\n").filter((line) => line.trim()).length,
    [urlsText],
  );

  const submit = async (): Promise<void> => {
    setError("");

    const formData = new FormData();
    if (mode === "upload") {
      const files = Array.from(imagesRef.current?.files ?? []);
      if (files.length === 0) {
        setError("Please select at least one image file.");
        return;
      }
      files.forEach((file) => formData.append("images", file));
    } else if (mode === "urls") {
      if (!urlsText.trim()) {
        setError("Please paste one or more image URLs.");
        return;
      }
      formData.append("urlsText", urlsText.trim());
    } else {
      const csvFile = csvRef.current?.files?.[0];
      if (!csvFile) {
        setError("Please choose a CSV file.");
        return;
      }
      formData.append("csvFile", csvFile);
    }

    formData.append("name", name.trim());
    formData.append("stylePrompt", stylePrompt.trim());
    formData.append("model", model);
    formData.append("variantsCount", variantsCount);
    formData.append("poseVariation", poseVariation === "1" ? "true" : "false");
    formData.append("poseStrength", poseStrength);

    setSubmitting(true);
    try {
      const job = await createJob(formData);
      navigate(`/jobs/${job.jobId}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <Link to="/" className="back-link">
        ← Back to jobs
      </Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">New Job</h1>
          <p className="page-sub">
            Convert photos into vector-style avatars while preserving face identity
          </p>
        </div>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      <div className="form-grid">
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Input Source</h3>
              <p className="card-sub">Choose how to supply the images for this job</p>
            </div>
          </div>
          <div className="card-body">
            <div className="seg">
              {MODES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={mode === option.value ? "seg-btn active" : "seg-btn"}
                  onClick={() => setMode(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="field">
              <label className="label" htmlFor="job-name">
                Job name <span style={{ fontWeight: 400, color: "var(--muted)" }}>(optional)</span>
              </label>
              <input
                id="job-name"
                className="input"
                placeholder="e.g. Student avatars — batch 21"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            {mode === "upload" ? (
              <div className="field">
                <label className="label" htmlFor="images">
                  Image files
                </label>
                <input
                  id="images"
                  ref={imagesRef}
                  className="file-input"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => setImageCount(event.target.files?.length ?? 0)}
                />
                <div className="hint">
                  {imageCount === 0
                    ? "No files selected."
                    : `${imageCount} file${imageCount === 1 ? "" : "s"} selected.`}
                </div>
              </div>
            ) : null}

            {mode === "urls" ? (
              <div className="field">
                <label className="label" htmlFor="urls">
                  Image URLs
                </label>
                <textarea
                  id="urls"
                  className="textarea mono"
                  placeholder={"https://example.com/image-1.jpg\nhttps://example.com/image-2.png"}
                  value={urlsText}
                  onChange={(event) => setUrlsText(event.target.value)}
                />
                <div className="hint">{urlCount} URLs detected · one per line</div>
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
                  onChange={(event) => setCsvName(event.target.files?.[0]?.name ?? "")}
                />
                <div className="hint">
                  {csvName || "Supports an input_image_url column, or links in the first column."}
                </div>
              </div>
            ) : null}

            <div className="field">
              <label className="label" htmlFor="style-prompt">
                Style prompt{" "}
                <span style={{ fontWeight: 400, color: "var(--muted)" }}>(optional)</span>
              </label>
              <textarea
                id="style-prompt"
                className="textarea small"
                maxLength={MAX_PROMPT_CHARS}
                placeholder="Example: Keep exact same face and pose. Apply clean flat vector style with warm colors."
                value={stylePrompt}
                onChange={(event) => setStylePrompt(event.target.value)}
              />
              <div className="hint">
                {stylePrompt.length} / {MAX_PROMPT_CHARS} characters · leave empty for the default
                prompt
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Generation Settings</h3>
              <p className="card-sub">Model, variants and pose control</p>
            </div>
          </div>
          <div className="card-body">
            <div className="field">
              <label className="label" htmlFor="model">
                Model
              </label>
              <select
                id="model"
                className="select"
                style={{ width: "100%" }}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="gpt-image-1">gpt-image-1</option>
                <option value="gpt-image-1-mini">gpt-image-1-mini</option>
                <option value="dall-e-2">dall-e-2</option>
              </select>
              <div className="hint">gpt-image models give the strongest stylization.</div>
            </div>

            <div className="field">
              <label className="label" htmlFor="variants">
                Variants per image
              </label>
              <select
                id="variants"
                className="select"
                style={{ width: "100%" }}
                value={variantsCount}
                onChange={(event) => setVariantsCount(event.target.value)}
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map((value) => (
                  <option key={value} value={String(value)}>
                    {value}
                  </option>
                ))}
              </select>
              <div className="hint">Each variant is a separate generation and API call.</div>
            </div>

            <div className="field">
              <label className="label" htmlFor="pose">
                Pose variation
              </label>
              <select
                id="pose"
                className="select"
                style={{ width: "100%" }}
                value={poseVariation}
                onChange={(event) => setPoseVariation(event.target.value)}
              >
                <option value="0">Off — keep original pose</option>
                <option value="1">On — vary pose per variant</option>
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="pose-strength">
                Pose strength
              </label>
              <select
                id="pose-strength"
                className="select"
                style={{ width: "100%" }}
                value={poseStrength}
                disabled={poseVariation !== "1"}
                onChange={(event) => setPoseStrength(event.target.value)}
              >
                <option value="subtle">Subtle</option>
                <option value="medium">Medium</option>
              </select>
              <div className="hint">Enabled when pose variation is on.</div>
            </div>

            <button
              type="button"
              className="btn"
              style={{ width: "100%", justifyContent: "center", marginTop: 6 }}
              disabled={submitting}
              onClick={() => void submit()}
            >
              {submitting ? "Starting…" : "▶ Start Vectorize"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
