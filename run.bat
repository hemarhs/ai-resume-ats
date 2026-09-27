@echo off
REM ATSight - start the app on Windows (double-click or run from the project folder)
cd /d "%~dp0"
if not exist venv\Scripts\python.exe (
  echo Creating virtual environment...
  python -m venv venv
)
call venv\Scripts\activate.bat
python -c "import fastapi, psycopg, spacy" 2>nul || (
  echo Installing dependencies...
  python -m pip install -r requirements.txt
  python -m spacy download en_core_web_md
)
echo.
echo  ATSight is starting - open http://localhost:8080
echo.
start "" http://localhost:8080
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8080
