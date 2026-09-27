"""Scan-history persistence (works on Neon Postgres or local SQLite via db.py)."""
import json
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from backend.database import db


def _serializable(obj: Dict) -> Dict:
    return json.loads(json.dumps(obj, default=lambda o: o.model_dump() if hasattr(o, 'model_dump') else str(o)))


def save_analysis(user_id: str, filename: str, analysis_result: Dict) -> str:
    result = _serializable(analysis_result)
    new_id = str(uuid.uuid4())
    created = result.get('created_at') or datetime.now(timezone.utc).isoformat()
    result['id'] = new_id
    db.execute(
        'INSERT INTO analyses (id, user_id, filename, ats_score, keyword_match, missing_keywords, created_at, analysis_result) '
        'VALUES (?,?,?,?,?,?,?,?)',
        (new_id, user_id, filename, float(result.get('ats_score', 0) or 0), float(result.get('keyword_match', 0) or 0),
         json.dumps(result.get('missing_keywords', [])), created, json.dumps(result)),
    )
    return new_id


def get_user_history(user_id: str) -> List[Dict]:
    rows = db.fetch_all(
        'SELECT * FROM analyses WHERE user_id=? ORDER BY created_at DESC', (user_id,)
    )
    out = []
    for r in rows:
        result = json.loads(r.get('analysis_result') or '{}')
        result['id'] = r['id']
        out.append({
            'id':               r['id'],
            'filename':         r.get('filename') or 'resume',
            'job_title':        (result.get('jd_comparison') or {}).get('job_title') or '',
            'ats_score':        r.get('ats_score') or 0,
            'keyword_match':    r.get('keyword_match') or 0,
            'missing_keywords': json.loads(r.get('missing_keywords') or '[]'),
            'created_at':       r.get('created_at') or '',
            'analysis_result':  result,
        })
    return out


def get_analysis(analysis_id: str, user_id: str) -> Optional[Dict]:
    r = db.fetch_one('SELECT analysis_result FROM analyses WHERE id=? AND user_id=?', (analysis_id, user_id))
    return json.loads(r['analysis_result']) if r else None


def delete_analysis(analysis_id: str, user_id: str) -> bool:
    return db.execute('DELETE FROM analyses WHERE id=? AND user_id=?', (analysis_id, user_id)) > 0
