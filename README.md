# ATSight: AI Resume ATS Scorer

ATSight checks your resume the way an applicant-tracking system (ATS) would. It gives you:

- an **ATS score** (0–100) made up of five weighted parts
- a **job-description match** showing matched and missing keywords, must-have skill gaps, and how closely your resume's meaning matches the job post
- a **skill evidence map** showing which of your listed skills are backed up by your projects or work experience
- a **fix-list** sorted by priority, with checklists and before/after examples
- **accounts and scan history**, with a score-trend chart and a PDF export

**Stack:** FastAPI · spaCy · Sentence-Transformers · Groq (Llama 3.3) · Neon Postgres · vanilla HTML/CSS/JS front-end. There's no build step, and a single server runs everything.

---

## Quick start (Windows)

1. Copy `.env.example` to `.env` and fill it in. See the [Configuration](#configuration) section below.
2. Double-click **`run.bat`**.
   - On first run it creates `venv`, installs the requirements and downloads the spaCy model.
   - It then opens **http://localhost:8000**.

### Manual start

```bash
python -m venv venv
venv\Scripts\activate            # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
python -m spacy download en_core_web_md
python -m uvicorn backend.main:app --port 8080
```

Open **http://localhost:8080**. The UI and the API run on the same server, and the API docs are at `/docs`.

> The Streamlit front-end has been removed. You don't need `streamlit run` anymore.

---

## Configuration

All settings go in `.env`:

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | recommended | Your **Neon** Postgres connection string. If it's empty, the app uses a local SQLite file (`data/app.db`). Tables are created automatically on startup. |
| `APP_SECRET_KEY` | recommended | A long random string used to sign login sessions. If it's empty, one is generated and saved in `data/.secret_key`. |
| `GOOGLE_CLIENT_ID` | optional | Turns on the **Continue with Google** button. |
| `GROQ_API_KEY` | optional | Turns on LLM parsing for the resume and job description. Without it, a built-in rule-based parser is used. |
| `GROQ_MODEL` | optional | Defaults to `llama-3.3-70b-versatile`. |

### Setting up Neon (free)

1. Go to [neon.tech](https://neon.tech) and create a project.
2. On the dashboard, click **Connect** and copy the connection string. It looks like this:
   `postgresql://user:password@ep-xxxx.aws.neon.tech/neondb?sslmode=require`
3. Paste it into `.env` as `DATABASE_URL=...` and restart the app.
4. The startup log should say `Database ready: Neon Postgres`.

### Google sign-in (optional)

1. Open Google Cloud Console and go to **APIs & Services → Credentials → Create credentials → OAuth client ID** (type: *Web application*).
2. Under **Authorized JavaScript origins**, add `http://localhost:8080`, plus your production URL later.
3. Put the client ID into `.env` as `GOOGLE_CLIENT_ID=...`.

---

## How scoring works

| Vital | Max | Based on |
|---|---|---|
| Formatting | 20 | sections present, bullet usage, structure |
| Keywords | 25 | keyword and skill density, plus JD overlap |
| Content & impact | 25 | action verbs, quantified achievements |
| Skill evidence | 15 | share of skills backed by projects or experience (embedding similarity) |
| ATS compatibility | 15 | location/privacy details, special characters, thin sections |

These are combined into the overall score. Bonuses and penalties are then applied, for example for missing JD keywords or very strong skill evidence.

## Built to keep working

- **Groq unavailable or no API key:** the app switches to a local rule-based parser, and the report shows which parser was used.
- **Sentence-Transformer model can't be downloaded:** a lightweight hashing embedder is used instead.
- **No `en_core_web_md`:** the app falls back to `en_core_web_sm`, then to a blank spaCy pipeline.
- **File-type detection** reads the file's own signature bytes. It no longer needs `libmagic`, which caused errors on Windows.

## Project structure

```
backend/
  main.py              FastAPI app: loads models, creates DB tables, serves the web UI
  api/auth.py          sign-up / sign-in / Google / sessions (JWT)
  api/routes.py        analyze, history, config, PDF endpoints
  database/db.py       Neon Postgres or SQLite connection + schema
  database/history_repo.py
  services/            parsing (Groq + local fallback), scoring, JD matching, feedback
web/
  index.html           single-page app shell
  assets/styles.css    theme
  assets/app.js        UI logic (router, scanner, results, history, auth)
jupyter notebooks/     research only, not used at runtime
```

## API

| Method | Path | Auth |
|---|---|---|
| POST | `/api/v1/auth/signup` · `/signin` · `/google` | – |
| GET | `/api/v1/auth/me` | Bearer |
| POST | `/api/v1/analyze-resume` (multipart: `resume`, `job_description`) | Bearer |
| GET / DELETE | `/api/v1/history` · `/api/v1/history/{id}` | Bearer |
| GET | `/api/v1/health` · `/api/v1/config` | – |
