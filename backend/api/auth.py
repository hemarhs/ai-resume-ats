"""
Built-in authentication.

 • Email + password  → PBKDF2-SHA256 hashed (stdlib, 260k iterations, per-user salt)
 • Google sign-in    → Google Identity Services ID token, verified against Google's JWKS
 • Sessions          → HS256 JWT signed with APP_SECRET_KEY, sent as  Authorization: Bearer <token>
"""
import base64
import hashlib
import hmac
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from backend.core.config import APP_SECRET_KEY, GOOGLE_CLIENT_ID, TOKEN_TTL_DAYS
from backend.database import db

logger = logging.getLogger('ats_resume_scorer')

router = APIRouter(prefix='/api/v1/auth', tags=['Auth'])
_bearer = HTTPBearer(auto_error=False)

EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
_PBKDF2_ITER = 260_000


# ───────────────────────── password hashing ─────────────────────────
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, _PBKDF2_ITER)
    return f'pbkdf2_sha256${_PBKDF2_ITER}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}'


def verify_password(password: str, stored: Optional[str]) -> bool:
    try:
        _, iters, salt_b64, hash_b64 = (stored or '').split('$')
        dk = hashlib.pbkdf2_hmac('sha256', password.encode(), base64.b64decode(salt_b64), int(iters))
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except Exception:
        return False


# ───────────────────────── tokens ─────────────────────────
def create_token(user: Dict) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        'sub': user['id'],
        'email': user['email'],
        'iat': now,
        'exp': now + timedelta(days=TOKEN_TTL_DAYS),
    }
    return jwt.encode(payload, APP_SECRET_KEY, algorithm='HS256')


def _public_user(u: Dict) -> Dict:
    return {
        'id': u['id'],
        'email': u['email'],
        'name': u.get('name') or u['email'].split('@')[0],
        'avatar_url': u.get('avatar_url'),
        'provider': u.get('provider', 'password'),
    }


def _session(u: Dict) -> Dict:
    return {'access_token': create_token(u), 'token_type': 'bearer', 'user': _public_user(u)}


def get_current_user(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> str:
    if creds is None or not creds.credentials:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Please sign in to continue.',
                            headers={'WWW-Authenticate': 'Bearer'})
    try:
        payload = jwt.decode(creds.credentials, APP_SECRET_KEY, algorithms=['HS256'])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Session expired — please sign in again.')
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Invalid session — please sign in again.')
    return payload['sub']


# ───────────────────────── request models ─────────────────────────
class SignUpIn(BaseModel):
    email: str
    password: str
    name: str = ''


class SignInIn(BaseModel):
    email: str
    password: str


class GoogleIn(BaseModel):
    credential: str


# ───────────────────────── endpoints ─────────────────────────
@router.post('/signup')
async def signup(body: SignUpIn):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, 'Please enter a valid email address.')
    if len(body.password) < 8:
        raise HTTPException(400, 'Password must be at least 8 characters.')

    existing = await run_in_threadpool(db.fetch_one, 'SELECT * FROM users WHERE email=?', (email,))
    if existing:
        if existing.get('password_hash'):
            raise HTTPException(409, 'An account with this email already exists — sign in instead.')
        # Google-only account adding a password
        await run_in_threadpool(db.execute, 'UPDATE users SET password_hash=? WHERE id=?',
                                (hash_password(body.password), existing['id']))
        return _session(existing)

    user = {
        'id': str(uuid.uuid4()),
        'email': email,
        'name': body.name.strip() or email.split('@')[0],
        'avatar_url': None,
        'provider': 'password',
    }
    pw_hash = await run_in_threadpool(hash_password, body.password)
    await run_in_threadpool(
        db.execute,
        'INSERT INTO users (id, email, name, avatar_url, password_hash, provider, created_at) VALUES (?,?,?,?,?,?,?)',
        (user['id'], email, user['name'], None, pw_hash, 'password', datetime.now(timezone.utc).isoformat()),
    )
    logger.info(f'New user signed up: {email}')
    return _session(user)


@router.post('/signin')
async def signin(body: SignInIn):
    email = body.email.strip().lower()
    user = await run_in_threadpool(db.fetch_one, 'SELECT * FROM users WHERE email=?', (email,))
    if not user:
        raise HTTPException(401, 'No account found for this email — create one first.')
    if not user.get('password_hash'):
        raise HTTPException(401, 'This account uses Google sign-in. Use "Continue with Google".')
    ok = await run_in_threadpool(verify_password, body.password, user['password_hash'])
    if not ok:
        raise HTTPException(401, 'Wrong email or password.')
    return _session(user)


_google_jwks: Optional[jwt.PyJWKClient] = None


def _verify_google(credential: str) -> Dict:
    global _google_jwks
    if _google_jwks is None:
        _google_jwks = jwt.PyJWKClient('https://www.googleapis.com/oauth2/v3/certs', cache_keys=True)
    key = _google_jwks.get_signing_key_from_jwt(credential).key
    return jwt.decode(
        credential, key, algorithms=['RS256'], audience=GOOGLE_CLIENT_ID,
        issuer=['https://accounts.google.com', 'accounts.google.com'],
    )


@router.post('/google')
async def google_signin(body: GoogleIn):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(501, 'Google sign-in is not configured (set GOOGLE_CLIENT_ID in .env).')
    try:
        info = await run_in_threadpool(_verify_google, body.credential)
    except Exception as exc:
        logger.warning(f'Google token verification failed: {exc}')
        raise HTTPException(401, 'Google sign-in failed — please try again.')
    if not info.get('email_verified'):
        raise HTTPException(401, 'Your Google email is not verified.')

    email = info['email'].lower()
    user = await run_in_threadpool(db.fetch_one, 'SELECT * FROM users WHERE email=?', (email,))
    if not user:
        user = {
            'id': str(uuid.uuid4()), 'email': email,
            'name': info.get('name') or email.split('@')[0],
            'avatar_url': info.get('picture'), 'provider': 'google',
        }
        await run_in_threadpool(
            db.execute,
            'INSERT INTO users (id, email, name, avatar_url, password_hash, provider, created_at) VALUES (?,?,?,?,?,?,?)',
            (user['id'], email, user['name'], user['avatar_url'], None, 'google', datetime.now(timezone.utc).isoformat()),
        )
    elif info.get('picture') and not user.get('avatar_url'):
        await run_in_threadpool(db.execute, 'UPDATE users SET avatar_url=? WHERE id=?', (info['picture'], user['id']))
        user['avatar_url'] = info['picture']
    return _session(user)


@router.get('/me')
async def me(user_id: str = Depends(get_current_user)):
    user = await run_in_threadpool(db.fetch_one, 'SELECT * FROM users WHERE id=?', (user_id,))
    if not user:
        raise HTTPException(401, 'Account no longer exists — please sign in again.')
    return _public_user(user)
