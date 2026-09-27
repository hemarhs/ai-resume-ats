// Where the frontend finds the backend API.
// Local (served by uvicorn) → same server.  Deployed (Vercel) → Render backend.
window.ATSIGHT_API_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? ''
  : 'https://atsight-api.onrender.com';
