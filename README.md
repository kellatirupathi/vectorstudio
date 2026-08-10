# Vector Studio

Bulk vector-style avatar generator. React frontend + Node/Express API.
Converts photos into vector-style illustrations while preserving face identity.

```
web/     React 18 + Vite + TypeScript   → deploys to Vercel
server/  Express + TypeScript            → deploys to Render
legacy/  Archived Python app            → not deployed (see legacy/README.md)
```

`legacy/` holds the original Python implementation plus the **Drive-to-Cloud**
module (`app.py`), which was not ported. Nothing in it is built or deployed.

## Architecture

The API is a **single long-running process**. There is no Redis, no Celery, no Docker.

- `POST /api/jobs` writes inputs to disk, returns a `jobId` immediately.
- The job runs in the background; a bounded worker pool (`WORKER_CONCURRENCY`)
  processes images concurrently.
- Job state lives in memory (`server/src/services/jobStore.ts`).

### Known trade-offs

| Behaviour | Consequence |
|---|---|
| State is in memory | Jobs and job history are **lost on restart or redeploy** |
| Single instance only | Never scale to 2+ instances; polling would hit the wrong one |
| Scale up, not out | More throughput = bigger machine or higher `WORKER_CONCURRENCY` |

The dashboard will look empty after every deploy. To fix this, implement the
functions in `jobStore.ts` against SQLite or Mongo — nothing outside that module
touches the store directly.

## Local development

```bash
# 1. API
cd server
cp .env.example .env      # fill in your keys
npm install
npm run dev               # http://localhost:8080

# 2. Frontend (separate terminal)
cd web
npm install
npm run dev               # http://localhost:3000
```

Vite proxies `/api` to `localhost:8080` in dev, so no CORS setup is needed locally.

## Deployment

### API → Render

1. Push this repo to GitHub. **Confirm `.env` is gitignored first** — it contains
   live API keys.
2. In Render: **New → Blueprint**, select the repo. It reads `render.yaml`.
3. Set these environment variables in the dashboard (they are `sync: false`):
   - `OPENAI_API_KEY`
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
   - `APP_ACCESS_TOKEN` — generate with `openssl rand -hex 32`
   - `ALLOWED_ORIGINS` — your Vercel URL, e.g. `https://vectorstudio.vercel.app`
4. Deploy. Note the API URL, e.g. `https://vectorstudio-api.onrender.com`.

**Do not use the free plan.** It sleeps after 15 minutes idle, and a sleeping
process kills in-flight jobs — with in-memory state there is nothing to recover.

### Frontend → Vercel

1. In Vercel: **Add New → Project**, select the repo, set **Root Directory** to `web`.
2. Add environment variable:
   - `VITE_API_BASE_URL` = your Render API URL (no trailing slash)
3. Deploy.

### After deploying

Open the site. On first use, the frontend needs the access token — set it once
from the browser console:

```js
localStorage.setItem("vectorstudio.accessToken", "your-token-here");
```

Share that token with teammates. It is sent as `x-access-token` on every request.

## Security notes

- **`APP_ACCESS_TOKEN` is the only thing preventing strangers from spending your
  OpenAI credits.** If it is unset, the API is completely open. Always set it in
  production.
- API keys stay server-side and are never sent to the browser.
- Set `ALLOWED_ORIGINS`; leaving it empty allows any origin.
- The token is stored in `localStorage`, which is adequate for an internal tool
  but is not a substitute for real user accounts.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check (no auth) |
| `GET` | `/api/jobs` | List all jobs |
| `GET` | `/api/jobs/stats` | Aggregate counters for the dashboard |
| `POST` | `/api/jobs` | Create a job (multipart) |
| `GET` | `/api/jobs/:jobId` | Job detail with results and errors |
| `GET` | `/api/jobs/:jobId/result.csv` | Download the result CSV |

`POST /api/jobs` accepts `images` (files), `urlsText`, `csvFile`, `name`,
`model`, `variantsCount`, `stylePrompt`, `poseVariation`, `poseStrength`.

Output CSV always has exactly two columns: `input_image`, `generated_image`.
Failed rows are included with an empty `generated_image`.

## Processing pipeline

1. Read uploaded bytes or download from the URL.
2. Normalize: EXIF rotation, RGBA, PNG, downscale under 4 MB.
3. Apply the variant prompt profile (10 style × outfit × pose presets).
4. Transform via `edit` (image-to-image, best identity preservation) or
   `generate_from_reference` (identity analysis, then fresh generation).
5. Upload the PNG to Cloudinary under `{prefix}/{jobId}`.
6. Rewrite the live result CSV after every item.

Retries use exponential backoff with jitter for OpenAI, Cloudinary and downloads.
Unsupported OpenAI parameters (`quality`, `input_fidelity`, `response_format`) and
enforced model substitutions are detected from the 400 response and retried
automatically.
