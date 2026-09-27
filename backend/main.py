import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import backend.utils.file_utils  # noqa: F401  (configures logging handlers)
from backend.api.auth import router as auth_router
from backend.api.routes import router
from backend.core.config import (
    ALLOWED_ORIGINS,
    APP_DESCRIPTION,
    APP_TITLE,
    APP_VERSION,
    SENTENCE_TRANSFORMER_MODEL,
    SPACY_MODEL_PRIMARY,
    SPACY_MODEL_SECONDARY,
    WEB_DIR,
)

logger = logging.getLogger('ats_resume_scorer')


def _load_spacy():
    import spacy
    for name in (SPACY_MODEL_PRIMARY, SPACY_MODEL_SECONDARY):
        try:
            nlp = spacy.load(name)
            logger.info(f'Loaded spaCy model: {name}')
            return nlp
        except OSError:
            logger.warning(f'spaCy model {name} not installed')
    logger.warning('No spaCy model found — using a blank English pipeline. '
                   'Run: python -m spacy download en_core_web_md')
    return spacy.blank('en')


def _load_embedder():
    try:
        from sentence_transformers import SentenceTransformer
        emb = SentenceTransformer(SENTENCE_TRANSFORMER_MODEL)
        logger.info(f'Loaded SentenceTransformer: {SENTENCE_TRANSFORMER_MODEL}')
        return emb, SENTENCE_TRANSFORMER_MODEL
    except Exception as exc:
        from backend.services.fallback_embedder import HashingEmbedder
        logger.warning(f'SentenceTransformer unavailable ({exc}) — using lightweight fallback embedder')
        return HashingEmbedder(), HashingEmbedder.name


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info('Starting ATS Resume Analyzer API...')
    app.state.nlp = _load_spacy()
    app.state.embedder, app.state.embedder_name = _load_embedder()

    from backend.database.db import init_db
    app.state.db_name = init_db()   # creates users + analyses tables if missing

    logger.info('All models loaded - app is ready. Open it in your browser (e.g. http://localhost:8080).')
    yield
    logger.info('Shutting down the API')


app = FastAPI(
    title=APP_TITLE,
    description=APP_DESCRIPTION,
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url='/docs',
    redoc_url='/redoc',
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(auth_router)
app.include_router(router)

# ── Web UI ────────────────────────────────────────────────────────────
if WEB_DIR.exists():
    app.mount('/assets', StaticFiles(directory=WEB_DIR / 'assets'), name='assets')

    @app.get('/', include_in_schema=False)
    async def index():
        return FileResponse(WEB_DIR / 'index.html')


if __name__ == '__main__':
    import uvicorn
    uvicorn.run('backend.main:app', host='127.0.0.1', port=8080, reload=False)
