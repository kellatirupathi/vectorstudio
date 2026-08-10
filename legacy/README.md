# Legacy Python app (archived)

Preserved for reference and for the **Drive-to-Cloud** feature, which was NOT
ported to the Node/React rewrite in `../server` + `../web`.

**Nothing here is deployed.** It is excluded from the Render and Vercel builds.

## What is here

| File | Purpose |
|---|---|
| `app.py` | Drive-to-Cloud: Google Drive folder → Cloudinary → CSV, served at `/drivetocloud`. Mounts the vectorizer app at `/`. |
| `backend/` | The original Python vectorizer (superseded by `../server`). Kept because `app.py` imports `backend.main`. |
| `frontend/index.html` | The original single-page UI (superseded by `../web`). |
| `requirements.txt` | Python dependencies for the vectorizer only. |

## Known issues before you run this

**1. The `/drivetocloud` page will fail.** `app.py` line 432 renders
`templates/index.html` via Jinja2, but no `templates/` directory exists in this
project. You will get a `TemplateNotFound` error on that route. The API routes
(`/upload`, `/events/{job_id}`, `/download/{job_id}`) do not use the template and
should work.

**2. Extra dependencies are not in `requirements.txt`.** `app.py` needs Google
libraries that the vectorizer never used:

```bash
pip install google-api-python-client google-auth google-auth-oauthlib jinja2
```

**3. Separate credentials.** Drive-to-Cloud uses its own env vars, distinct from
the vectorizer's:

- `D2C_CLOUDINARY_CLOUD_NAME`, `D2C_CLOUDINARY_API_KEY`, `D2C_CLOUDINARY_API_SECRET`
- `GOOGLE_APPLICATION_CREDENTIALS` (service account path), **or** OAuth:
  `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`

## Running it locally

```bash
cd legacy
python -m venv .venv
.venv\Scripts\Activate.ps1        # Windows
pip install -r requirements.txt
pip install google-api-python-client google-auth google-auth-oauthlib jinja2
uvicorn app:app --host 0.0.0.0 --port 8000
```

Then open http://localhost:8000/drivetocloud (see issue 1 above).

## Note on the vectorizer here

`backend/` is the pre-rewrite Python implementation. It has no Redis or Celery
dependency — job state is in-process (`backend/jobstore.py`). It works, but the
Node version in `../server` is the maintained one. Use this only as a reference
for behaviour comparison.
