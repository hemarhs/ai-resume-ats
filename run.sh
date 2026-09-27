#!/usr/bin/env bash
# ATSight - start the app on macOS / Linux
cd "$(dirname "$0")"
[ -d venv ] || python3 -m venv venv
source venv/bin/activate
python -c "import fastapi, psycopg, spacy" 2>/dev/null || { pip install -r requirements.txt && python -m spacy download en_core_web_md; }
echo "ATSight → http://localhost:8000"
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
