import os
from pathlib import Path

# Load .env from the project root (two levels up from this file) explicitly —
# load_dotenv() with no args relies on caller-frame inspection that can fail
# silently under uvicorn reload, leaving env vars unset.
try:
    from dotenv import load_dotenv
    _ENV_PATH = Path(__file__).resolve().parents[2] / '.env'
    load_dotenv(_ENV_PATH)
except ImportError:
    pass

#api metadata
APP_TITLE='ATS RESUME ANALYZER API'
APP_VERSION='1.0.0'
APP_DESCRIPTION='analyse resumes against job description using nlp + ml'

# Comma-separated list in .env (ALLOWED_ORIGINS=...) or sensible local defaults.
# The web UI is served by FastAPI itself, so same-origin requests need no CORS.
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv(
        'ALLOWED_ORIGINS',
        'http://localhost:8000,http://127.0.0.1:8000,http://localhost:8080,http://127.0.0.1:8080,http://localhost:5500,http://127.0.0.1:5500',
    ).split(',') if o.strip()
]

#file 
MAX_FILE_SIZE_MB=5
MAX_FILE_SIZE_BYTES=MAX_FILE_SIZE_MB*1024*1024

SUPPORTED_EXTENSIONS = {'.pdf', '.doc', '.docx'}

SPACY_MODEL_PRIMARY = os.getenv("SPACY_MODEL", "en_core_web_md")  # set SPACY_MODEL=en_core_web_sm on small servers
SPACY_MODEL_SECONDARY='en_core_web_sm'
SENTENCE_TRANSFORMER_MODEL = os.getenv("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")

# Score component weights — this is business logic treated as config
SCORE_WEIGHTS = {
    "formatting": 20, "keywords": 25, "content": 25,
    "skill_validation": 15, "ats_compatibility": 15,
}

JD_KEYWORD_WEIGHT=0.6
JD_SEMANTIC_WEIGHT=0.4

# ── Database (Neon Postgres) ──
# Paste your Neon connection string here via .env. Empty → local SQLite (data/app.db).
DATABASE_URL = os.getenv('DATABASE_URL', '').strip()

# ── Auth ──
GOOGLE_CLIENT_ID = os.getenv('GOOGLE_CLIENT_ID', '').strip()   # optional: enables "Continue with Google"
TOKEN_TTL_DAYS   = int(os.getenv('TOKEN_TTL_DAYS', '7'))


def _load_secret_key() -> str:
    """APP_SECRET_KEY from .env, else a random key generated once and kept in data/.secret_key."""
    key = os.getenv('APP_SECRET_KEY', '').strip()
    if key:
        return key
    import secrets
    path = Path(__file__).resolve().parents[2] / 'data' / '.secret_key'
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return path.read_text().strip()
    key = secrets.token_urlsafe(48)
    path.write_text(key)
    return key


APP_SECRET_KEY = _load_secret_key()

# ── LLM ──
GROQ_API_KEY = os.getenv('GROQ_API_KEY', '')
GROQ_MODEL   = os.getenv('GROQ_MODEL', 'llama-3.3-70b-versatile')

# Where the web UI lives (served at "/")
WEB_DIR = Path(__file__).resolve().parents[2] / 'web'
