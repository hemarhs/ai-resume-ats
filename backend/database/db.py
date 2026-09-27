"""
Database access — Neon Postgres in production, SQLite locally.

Set DATABASE_URL in .env to your Neon connection string, e.g.
    DATABASE_URL=postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require
If DATABASE_URL is empty, a local SQLite file (data/app.db) is used instead,
so the app always runs.
"""
import logging
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from backend.core.config import DATABASE_URL

logger = logging.getLogger('ats_resume_scorer')

IS_POSTGRES = DATABASE_URL.startswith(('postgres://', 'postgresql://'))
SQLITE_PATH = Path(__file__).resolve().parents[2] / 'data' / 'app.db'

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        name          TEXT,
        avatar_url    TEXT,
        password_hash TEXT,
        provider      TEXT NOT NULL DEFAULT 'password',
        created_at    TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS analyses (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename         TEXT,
        ats_score        REAL,
        keyword_match    REAL,
        missing_keywords TEXT,
        created_at       TEXT NOT NULL,
        analysis_result  TEXT
    )""",
    'CREATE INDEX IF NOT EXISTS idx_analyses_user ON analyses(user_id, created_at)',
]


@contextmanager
def _connect():
    if IS_POSTGRES:
        import psycopg
        from psycopg.rows import dict_row
        con = psycopg.connect(DATABASE_URL, row_factory=dict_row, connect_timeout=15)
    else:
        SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(SQLITE_PATH)
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA foreign_keys = ON')
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def _sql(query: str) -> str:
    # Write queries with "?" placeholders; psycopg wants "%s"
    return query.replace('?', '%s') if IS_POSTGRES else query


def execute(query: str, params: Iterable[Any] = ()) -> int:
    with _connect() as con:
        cur = con.execute(_sql(query), tuple(params))
        return cur.rowcount


def fetch_all(query: str, params: Iterable[Any] = ()) -> List[Dict]:
    with _connect() as con:
        rows = con.execute(_sql(query), tuple(params)).fetchall()
        return [dict(r) for r in rows]


def fetch_one(query: str, params: Iterable[Any] = ()) -> Optional[Dict]:
    rows = fetch_all(query, params)
    return rows[0] if rows else None


def init_db() -> str:
    """Create tables if needed. Returns a human-readable backend name."""
    with _connect() as con:
        for stmt in SCHEMA:
            con.execute(stmt)
    name = 'Neon Postgres' if IS_POSTGRES else f'SQLite ({SQLITE_PATH.name})'
    logger.info(f'Database ready: {name}')
    return name
