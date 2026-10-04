/* ════════════════════════════════════════════════════════════════
   ATSight — front-end (vanilla JS, no build step)
   Talks to the FastAPI backend at the same origin: /api/v1/...
   ════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  // ───────────────────────── state ─────────────────────────
  const TOKEN_KEY = 'atsight.token';
  // Backend URL. Empty = same server (local). On Vercel it is set in assets/config.js.
  const API_BASE = String(window.ATSIGHT_API_URL || '').replace(/\/+$/, '');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const S = {
    token: store.get(TOKEN_KEY),
    user: null,
    config: {},
    file: null,
    jd: '',
    lastResult: null,
    history: null,
    pendingRoute: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const app = $('#app');

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function scoreColor(s) {
    if (s >= 80) return 'var(--lime)';
    if (s >= 65) return 'var(--sky)';
    if (s >= 50) return 'var(--amber)';
    return 'var(--coral)';
  }
  function grade(s) {
    if (s >= 90) return 'A+'; if (s >= 80) return 'A'; if (s >= 70) return 'B';
    if (s >= 60) return 'C'; if (s >= 50) return 'D'; return 'F';
  }
  function headline(s) {
    if (s >= 85) return 'Built to <em>sail through</em> the filters.';
    if (s >= 70) return 'Solid — a few <em>tweaks</em> from great.';
    if (s >= 55) return 'Readable, but the bots <em>hesitate</em>.';
    return 'The filters will <em>likely</em> drop this one.';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

  // ───────────────────────── toasts ─────────────────────────
  function toast(msg, type = 'ok', ms = 3600) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.transition = '.3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ms);
  }

  // ───────────────────────── API ─────────────────────────
  async function api(path, { method = 'GET', body, form, auth = true } = {}) {
    const headers = {};
    if (auth && S.token) headers.Authorization = `Bearer ${S.token}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

    let res;
    try {
      res = await fetch(`${API_BASE}/api/v1${path}`, { method, headers, body: payload });
    } catch {
      throw new Error('Cannot reach the server. Is the backend running?');
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json().catch(() => null);

    if (res.status === 401 && auth && S.token) {
      signOut(true);
      openAuth('signin', data?.detail || 'Your session expired — please sign in again.');
    }
    if (!res.ok) {
      let msg = data?.detail;
      if (Array.isArray(msg)) msg = msg.map((d) => d.msg).join(', ');
      throw Object.assign(new Error(msg || `Request failed (${res.status})`), { status: res.status });
    }
    return data;
  }

  // ───────────────────────── auth ─────────────────────────
  function setSession(data) {
    S.token = data.access_token;
    S.user = data.user;
    store.set(TOKEN_KEY, S.token);
    S.history = null;
    renderNav();
  }
  function signOut(silent) {
    S.token = null; S.user = null; S.history = null; S.lastResult = null;
    store.del(TOKEN_KEY);
    renderNav();
    if (!silent) { toast('Signed out'); location.hash = '#/'; }
  }
  async function restoreSession() {
    if (!S.token) return;
    try { S.user = await api('/auth/me'); }
    catch { S.token = null; store.del(TOKEN_KEY); }
  }

  let authMode = 'signin';
  function setAuthMode(mode) {
    authMode = mode;
    const up = mode === 'signup';
    $$('[data-auth-tab]').forEach((b) => b.classList.toggle('active', b.dataset.authTab === mode));
    $('.seg').classList.toggle('right', up);
    $('#authTitle').textContent = up ? 'Make it yours.' : 'Welcome back.';
    $('.auth-sub').textContent = up ? 'Create a free account — takes ten seconds.' : 'Sign in to scan resumes and keep your history.';
    $('.name-field').classList.toggle('hidden', !up);
    $('#authSubmit span').textContent = up ? 'Create account' : 'Sign in';
    $('#authForm [name=password]').autocomplete = up ? 'new-password' : 'current-password';
    $('#authError').textContent = '';
  }
  function openAuth(mode = 'signin', message = '') {
    setAuthMode(mode);
    $('#authModal').classList.add('open');
    $('#authModal').setAttribute('aria-hidden', 'false');
    if (message) $('#authError').textContent = message;
    setTimeout(() => $('#authForm [name=email]').focus(), 60);
    mountGoogle();
  }
  function closeAuth() {
    $('#authModal').classList.remove('open');
    $('#authModal').setAttribute('aria-hidden', 'true');
  }

  let googleLoaded = false;
  function mountGoogle() {
    const cid = S.config.google_client_id;
    if (!cid) return;
    $('#googleWrap').classList.remove('hidden');
    const render = () => {
      window.google.accounts.id.initialize({ client_id: cid, callback: onGoogleCredential, ux_mode: 'popup' });
      $('#googleBtn').innerHTML = '';
      window.google.accounts.id.renderButton($('#googleBtn'), {
        theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 320,
      });
    };
    if (googleLoaded && window.google?.accounts) return render();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => { googleLoaded = true; render(); };
    s.onerror = () => $('#googleWrap').classList.add('hidden');
    document.head.appendChild(s);
  }
  async function onGoogleCredential(resp) {
    try {
      const data = await api('/auth/google', { method: 'POST', body: { credential: resp.credential }, auth: false });
      afterLogin(data);
    } catch (e) { $('#authError').textContent = e.message; }
  }
  function afterLogin(data) {
    setSession(data);
    closeAuth();
    toast(`Hey ${data.user.name.split(' ')[0]} — you're in.`);
    const next = S.pendingRoute; S.pendingRoute = null;
    if (next && location.hash !== next) location.hash = next; else route();
  }

  function bindAuthModal() {
    $$('[data-close]', $('#authModal')).forEach((el) => el.addEventListener('click', closeAuth));
    $$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.authTab)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAuth(); });
    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const email = String(f.get('email') || '').trim();
      const password = String(f.get('password') || '');
      const err = $('#authError');
      if (!email || !password) { err.textContent = 'Email and password are required.'; return; }
      if (authMode === 'signup' && password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
      const btn = $('#authSubmit');
      btn.disabled = true;
      const label = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        const data = await api(`/auth/${authMode}`, {
          method: 'POST', auth: false,
          body: authMode === 'signup' ? { email, password, name: String(f.get('name') || '') } : { email, password },
        });
        e.target.reset();
        afterLogin(data);
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        btn.disabled = false; btn.innerHTML = label;
      }
    });
  }

  // ───────────────────────── nav ─────────────────────────
  function renderNav() {
    const right = $('#navRight');
    if (S.user) {
      const initials = (S.user.name || S.user.email).slice(0, 1).toUpperCase();
      right.innerHTML = `
        <div class="user-chip" id="userChip">
          <button class="avatar" aria-label="Account menu" style="border:0;padding:0">${S.user.avatar_url ? `<img src="${esc(S.user.avatar_url)}" alt="" referrerpolicy="no-referrer">` : esc(initials)}</button>
          <span class="uname">${esc(S.user.name)}</span>
          <div class="user-menu">
            <p>${esc(S.user.email)}</p>
            <button data-go="#/history">My scan history</button>
            <button data-go="#/scan">New scan</button>
            <button id="signOutBtn">Sign out</button>
          </div>
        </div>`;
      const chip = $('#userChip');
      chip.addEventListener('click', (e) => { e.stopPropagation(); chip.classList.toggle('open'); });
      document.addEventListener('click', () => chip.classList.remove('open'));
      $$('[data-go]', chip).forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
      $('#signOutBtn').addEventListener('click', () => signOut());
    } else {
      right.innerHTML = `
        <button class="btn btn-ghost btn-sm" id="navSignIn">Sign in</button>
        <button class="btn btn-lime btn-sm" id="navSignUp">Get started</button>`;
      $('#navSignIn').addEventListener('click', () => openAuth('signin'));
      $('#navSignUp').addEventListener('click', () => openAuth('signup'));
    }
  }

  // ───────────────────────── router ─────────────────────────
  const routes = {
    '/': viewLanding,
    '/scan': viewScan,
    '/history': viewHistory,
    '/playbook': viewPlaybook,
    '/report': viewReport,
  };
  const protectedRoutes = new Set(['/scan', '/history', '/report']);

  function route() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, param] = (() => {
      const parts = raw.split('/').filter(Boolean);
      return ['/' + (parts[0] || ''), parts[1]];
    })();
    $('#nav').classList.remove('open');
    $$('.nav-links a').forEach((a) => a.classList.toggle('active', a.dataset.route === path));

    if (protectedRoutes.has(path) && S.token && !S.user && !S.booted) {
      app.innerHTML = '<section class="page wrap"><div class="dim mono">connecting to server…</div></section>';
      S.ready.then(route);
      return;
    }
    if (protectedRoutes.has(path) && !S.user) {
      S.pendingRoute = location.hash;
      if (path !== '/') { viewLanding(); openAuth('signin', 'Sign in to use the scanner.'); }
      return;
    }
    (routes[path] || viewLanding)(param);
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    app.focus({ preventScroll: true });
    initReveal();
  }

  function goScan() {
    if (!S.user) { S.pendingRoute = '#/scan'; openAuth('signup'); return; }
    location.hash = '#/scan';
  }

  // ───────────────────────── LANDING ─────────────────────────
  function viewLanding() {
    const kws = ['Python', 'FastAPI', 'LangGraph', 'RAG', 'Docker', 'Kubernetes', 'PyTorch', 'SQL', 'AWS', 'React', 'MLOps', 'Terraform'];
    const marquee = (words) => {
      const row = words.map((w) => `<span>${w}</span><span class="sep">✦</span>`).join('');
      return `<div class="marquee-track">${row}${row}</div>`;
    };
    app.innerHTML = `
      <section class="hero">
        <div class="hero-grid-bg"></div>
        <div class="wrap hero-inner">
          <div>
            <span class="eyebrow"><span class="dot"></span>Resume X-ray · powered by NLP + LLMs</span>
            <h1>Read by <span class="strike">humans</span><br>Filtered by <span class="hl">bots.</span></h1>
            <p class="lede">Most resumes are screened by software before a person ever reads them. <b>ATSight</b> scans yours the way an applicant-tracking system does — and tells you exactly what to fix.</p>
            <div class="cta-row">
              <button class="btn btn-lime btn-scan" id="heroCta"><span>Scan my resume</span><i class="arrow">→</i></button>
              <a class="btn btn-ghost" href="#/playbook">Read the playbook</a>
            </div>
            <div class="hero-stats">
              <div><b data-count="5">0</b><span>scoring vitals</span></div>
              <div><b data-count="10">0</b><span>issue detectors</span></div>
              <div><b data-count="30" data-suffix="s">0</b><span>avg. scan time</span></div>
            </div>
          </div>
          <div class="scan-visual" aria-hidden="true">
            <div class="paper">
              <div class="p-name">Alex Rivera</div>
              <div class="p-role">ML ENGINEER · alex@mail.com</div>
              <div class="p-h">SUMMARY</div>
              <div class="p-line" style="width:96%"></div><div class="p-line" style="width:80%"></div>
              <div class="p-h">SKILLS</div>
              <div>${['Python', 'FastAPI', 'Docker', 'RAG', 'Kubernetes', 'SQL', 'PyTorch', 'Excel'].map((k, i) => `<span class="kw" data-kw="${i}">${k}</span>`).join('')}</div>
              <div class="p-h">EXPERIENCE</div>
              <div class="p-line" style="width:70%;background:#cfc8b9"></div>
              <div class="p-line" style="width:92%"></div><div class="p-line" style="width:86%"></div><div class="p-line" style="width:64%"></div>
              <div class="p-h">PROJECTS</div>
              <div class="p-line" style="width:90%"></div><div class="p-line" style="width:75%"></div>
              <div class="laser"></div>
            </div>
            <div class="float-card fc-score">
              <div class="num" id="heroNum">0</div>
              <div class="mono tiny dim">ATS<br>score</div>
            </div>
            <div class="float-card fc-match">
              <div class="mono tiny dim">JD match</div>
              <div style="display:flex;justify-content:space-between;margin-top:6px"><b>Senior ML Eng.</b><span class="mono lime">82%</span></div>
              <div class="bar"><i></i></div>
            </div>
          </div>
        </div>
      </section>

      <div class="marquee">${marquee(kws)}</div>
      <div class="marquee alt">${marquee(['Keywords', 'Evidence', 'Impact', 'Formatting', 'Match', 'Verbs', 'Metrics', 'Clarity'])}</div>

      <section class="section wrap">
        <div class="sec-head reveal">
          <div><span class="mono tiny dim">// How it works</span><h2>Three steps.<br><em>Zero</em> guesswork.</h2></div>
          <p>Upload once, get a full diagnosis: what the bots see, what they miss, and the exact edits that move your score.</p>
        </div>
        <div class="steps">
          <div class="step reveal"><div class="n">01</div><h3>Drop your resume</h3><p>PDF or DOCX. We extract every line — including hyperlinks hidden in the file.</p></div>
          <div class="step reveal"><div class="n">02</div><h3>Paste the job post</h3><p>Optional, but powerful: we semantically match you against what the recruiter actually asked for.</p></div>
          <div class="step reveal"><div class="n">03</div><h3>Fix what matters</h3><p>A prioritised fix-list with before/after rewrites. Re-scan and watch the needle move.</p></div>
        </div>
      </section>

      <section class="section wrap">
        <div class="sec-head reveal">
          <div><span class="mono tiny dim">// What you get</span><h2>A report card<br>for your <em>career</em>.</h2></div>
        </div>
        <div class="bento">
          <div class="tile t-a reveal">
            <span class="tag">01 — ATS SCORE</span>
            <h4>One number. Five vitals.</h4>
            <p>Formatting, keywords, content quality, skill evidence and ATS compatibility — weighted the way real screeners weigh them.</p>
            <svg class="mini-gauge" viewBox="0 0 200 200">${gaugeSVG(78, 200, 16, true)}</svg>
          </div>
          <div class="tile t-b reveal">
            <span class="tag">02 — JD MATCH</span>
            <h4>Semantic job matching</h4>
            <p>Sentence-embedding similarity + fuzzy keyword matching.</p>
            <div class="chip-cloud"><span class="chip hit">Python</span><span class="chip hit">FastAPI</span><span class="chip miss">Kafka</span><span class="chip hit">Docker</span><span class="chip gap">Terraform</span></div>
          </div>
          <div class="tile t-c reveal">
            <span class="tag">03 — SKILL EVIDENCE</span>
            <h4>Claims vs. proof</h4>
            <p>Every skill is cross-checked against your projects and experience.</p>
            <div class="big-num">9/12</div>
          </div>
          <div class="tile t-d reveal"><span class="tag">04 — FIX-LIST</span><h4>Before → after</h4><p>Concrete rewrites, not vague advice.</p></div>
          <div class="tile t-e reveal"><span class="tag">05 — HISTORY</span><h4>Track progress</h4><p>Every scan saved to your account.</p><div class="mini-bars"><i style="height:40%"></i><i style="height:55%"></i><i style="height:62%"></i><i style="height:74%"></i><i style="height:88%"></i></div></div>
          <div class="tile t-f reveal"><span class="tag">06 — EXPORT</span><h4>PDF report</h4><p>Print-ready report in one click.</p></div>
        </div>
      </section>

      <section class="wrap">
        <div class="cta-band reveal">
          <span class="mono tiny dim">// Ready?</span>
          <h2>Stop guessing.<br>Start <em class="lime">getting calls</em>.</h2>
          <button class="btn btn-lime btn-scan" id="bandCta"><span>Run my first scan</span><i class="arrow">→</i></button>
        </div>
        <footer class="footer"><span>© ${new Date().getFullYear()} ATSight — built with FastAPI, spaCy, Sentence-Transformers & Groq</span><span class="mono">v2.0</span></footer>
      </section>`;

    $('#heroCta').addEventListener('click', goScan);
    $('#bandCta').addEventListener('click', goScan);
    animateHero();
    $$('[data-count]').forEach((el) => countUp(el, +el.dataset.count, 1400, el.dataset.suffix || ''));
  }

  let heroTimer;
  function animateHero() {
    clearInterval(heroTimer);
    const states = ['hit', 'hit', 'hit', 'hit', 'hit', 'hit', 'hit', 'miss'];
    let i = 0;
    const num = $('#heroNum');
    const tick = () => {
      const kws = $$('.paper .kw');
      if (!kws.length) return clearInterval(heroTimer);
      if (i >= kws.length) { kws.forEach((k) => k.className = 'kw'); i = 0; if (num) num.textContent = '0'; return; }
      kws[i].classList.add(states[i]);
      i++;
      if (num) num.textContent = String(Math.round((i / kws.length) * 86));
    };
    heroTimer = setInterval(tick, 520);
  }

  function countUp(el, to, ms = 1200, suffix = '') {
    const start = performance.now();
    const step = (t) => {
      const p = clamp((t - start) / ms, 0, 1);
      const v = to * (1 - Math.pow(1 - p, 3));
      el.textContent = (Number.isInteger(to) ? Math.round(v) : v.toFixed(1)) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ───────────────────────── SVG helpers ─────────────────────────
  // 270° instrument gauge
  function gaugeSVG(score, size = 300, stroke = 18, mini = false) {
    const r = size / 2 - stroke - (mini ? 4 : 14);
    const c = size / 2;
    const circ = 2 * Math.PI * r;
    const arc = circ * 0.75;
    const off = arc * (1 - clamp(score, 0, 100) / 100);
    let ticks = '';
    if (!mini) {
      for (let k = 0; k <= 50; k++) {
        const a = (k / 50) * 270 * (Math.PI / 180);
        const major = k % 5 === 0;
        const r1 = r + stroke / 2 + 6, r2 = r1 + (major ? 12 : 6);
        ticks += `<line class="g-tick ${major ? 'major' : ''}" x1="${c + r1 * Math.cos(a)}" y1="${c + r1 * Math.sin(a)}" x2="${c + r2 * Math.cos(a)}" y2="${c + r2 * Math.sin(a)}"/>`;
      }
    }
    const col = scoreColor(score);
    return `
      ${ticks}
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--ink-3)" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${arc} ${circ}" ${mini ? 'transform="rotate(135 ' + c + ' ' + c + ')"' : ''}/>
      <circle class="g-fill" data-off="${off}" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" style="color:${col}" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${arc} ${circ}" stroke-dashoffset="${mini ? off : arc}" ${mini ? 'transform="rotate(135 ' + c + ' ' + c + ')"' : ''}/>`;
  }

  function ringSVG(pct, size = 64, stroke = 6, color) {
    const r = size / 2 - stroke;
    const circ = 2 * Math.PI * r;
    const col = color || scoreColor(pct);
    return `<svg viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--ink-3)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - clamp(pct, 0, 100) / 100)}" style="transition:stroke-dashoffset 1.4s var(--ease)"/></svg>`;
  }

  function segs(pct, color) {
    const on = Math.round((clamp(pct, 0, 100) / 100) * 20);
    return `<div class="segs" style="--c:${color}">${Array.from({ length: 20 }, (_, i) => `<i data-on="${i < on ? 1 : 0}"></i>`).join('')}</div>`;
  }

  // ───────────────────────── SCANNER ─────────────────────────
  const SAMPLE_JD = `Senior AI / ML Engineer

We're looking for an engineer to build production LLM features.

Requirements:
- 3+ years of Python
- FastAPI or Flask for REST APIs
- LLMs, RAG pipelines, LangChain or LangGraph
- Vector databases (FAISS, Pinecone)
- Docker, Kubernetes, AWS
- PyTorch and Hugging Face transformers
- CI/CD and MLOps practices

Nice to have:
- Terraform, Kafka
- Experience fine-tuning models`;

  function viewScan() {
    app.innerHTML = `
      <section class="page wrap">
        <div class="page-head scan-form">
          <span class="mono tiny dim">// Scanner</span>
          <h1>Put it under<br>the <em>lens</em>.</h1>
          <p>Upload your resume and (optionally) the job post you're targeting. Nothing is shared — reports are saved privately to your account.</p>
        </div>
        <div class="scan-form">
          <div class="scan-grid">
            <div class="panel">
              <div class="panel-label"><span><b>01</b> · Resume</span><span>PDF · DOCX · ≤ 5 MB</span></div>
              <label class="dropzone" id="dropzone" tabindex="0">
                <span class="dz-c1"></span><span class="dz-c2"></span>
                <input type="file" id="fileInput" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden />
                <div id="dzContent"></div>
              </label>
            </div>
            <div class="panel">
              <div class="panel-label"><span><b>02</b> · Job description</span><span>optional · recommended</span></div>
              <textarea class="jd-box" id="jdBox" placeholder="Paste the job description here…&#10;&#10;We'll compare your resume against it: matched keywords, missing skills and a semantic-fit score."></textarea>
              <div class="jd-foot"><span id="jdCount">0 words</span><span><button id="sampleJd" type="button">use a sample JD</button> · <button id="clearJd" type="button">clear</button></span></div>
            </div>
          </div>
          <div class="scan-actions">
            <span class="hint" id="scanHint">↑ add a resume to begin</span>
            <button class="btn btn-lime btn-scan" id="runScan" disabled><span>Run the scan</span><i class="arrow">→</i></button>
          </div>
        </div>
        <div id="resultsMount"></div>
      </section>`;

    const dz = $('#dropzone');
    const input = $('#fileInput');
    const jd = $('#jdBox');
    jd.value = S.jd;

    const renderDz = () => {
      if (S.file) {
        const ext = (S.file.name.split('.').pop() || '').toUpperCase();
        $('#dzContent').innerHTML = `
          <div class="file-card">
            <div class="file-badge">${esc(ext)}</div>
            <div><div class="fname">${esc(S.file.name)}</div><div class="fmeta">${fmtSize(S.file.size)} · ready to scan</div></div>
            <button type="button" class="icon-btn" id="removeFile" aria-label="Remove file">✕</button>
          </div>`;
        $('#removeFile').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); S.file = null; input.value = ''; renderDz(); });
      } else {
        $('#dzContent').innerHTML = `
          <div class="dz-icon"><i></i><i></i><i></i><i></i></div>
          <p class="dz-title">Drop your resume<br><em>or click to browse</em></p>
          <p class="dz-sub">we read text, sections & hidden hyperlinks</p>`;
      }
      $('#runScan').disabled = !S.file;
      $('#scanHint').textContent = S.file ? (jd.value.trim() ? '✓ resume + job post — full analysis' : '✓ ready · add a JD for match analysis') : '↑ add a resume to begin';
    };
    const takeFile = (f) => {
      if (!f) return;
      const ok = /\.(pdf|docx)$/i.test(f.name);
      if (!ok) return toast('Please upload a PDF or DOCX file.', 'err');
      if (f.size > 5 * 1024 * 1024) return toast('File is larger than 5 MB.', 'err');
      S.file = f; renderDz();
    };
    input.addEventListener('change', () => takeFile(input.files[0]));
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => takeFile(e.dataTransfer.files[0]));

    const updateJd = () => {
      S.jd = jd.value;
      const n = jd.value.trim() ? jd.value.trim().split(/\s+/).length : 0;
      $('#jdCount').textContent = `${n} words`;
      renderDz();
    };
    jd.addEventListener('input', updateJd);
    $('#sampleJd').addEventListener('click', () => { jd.value = SAMPLE_JD; updateJd(); });
    $('#clearJd').addEventListener('click', () => { jd.value = ''; updateJd(); });
    renderDz(); updateJd();

    $('#runScan').addEventListener('click', runScan);

    if (S.lastResult) renderResults(S.lastResult, $('#resultsMount'));
  }

  async function runScan() {
    if (!S.file) return;
    const overlay = document.createElement('div');
    overlay.className = 'scanning';
    overlay.innerHTML = `
      <div class="scanning-inner">
        <div class="scan-doc">
          <div class="p-line h"></div>
          ${Array.from({ length: 14 }, (_, i) => `<div class="p-line" style="width:${60 + ((i * 37) % 40)}%"></div>`).join('')}
          <div class="laser"></div>
        </div>
        <div class="term">
          <h3>Scanning…</h3>
          <div id="termLines"></div>
          <div class="prog"><i id="progBar"></i></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const steps = [
      ['Extracting text', 'from ' + S.file.name],
      ['Detecting sections', 'summary · skills · experience · projects'],
      ['Parsing with LLM', S.config.llm_enabled ? S.config.llm_model : 'local parser'],
      ['Embedding skills', 'sentence-transformers'],
      ['Cross-checking evidence', 'skills ↔ projects'],
      S.jd.trim() ? ['Matching job description', 'semantic + fuzzy'] : ['Scoring ATS compatibility', '5 vitals'],
      ['Writing your fix-list', 'prioritising by impact'],
    ];
    const lines = $('#termLines', overlay);
    const bar = $('#progBar', overlay);
    let done = false;
    const ticker = (async () => {
      for (let i = 0; i < steps.length && !done; i++) {
        $$('.ln', lines).forEach((l) => l.classList.remove('cur'));
        lines.insertAdjacentHTML('beforeend', `<div class="ln cur"><b>›</b> ${esc(steps[i][0])} <span class="mute">— ${esc(steps[i][1])}</span></div>`);
        bar.style.width = `${Math.min(92, ((i + 1) / steps.length) * 92)}%`;
        await sleep(i < 2 ? 700 : 1900);
      }
    })();

    const form = new FormData();
    form.append('resume', S.file);
    form.append('job_description', S.jd.trim());
    try {
      const result = await api('/analyze-resume', { method: 'POST', form });
      done = true;
      bar.style.width = '100%';
      lines.insertAdjacentHTML('beforeend', `<div class="ln"><b>✓</b> Done — score <b>${Math.round(result.ats_score)}</b></div>`);
      await sleep(550);
      S.lastResult = result;
      S.history = null;
      overlay.remove();
      renderResults(result, $('#resultsMount'));
      $('#resultsMount').scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
      done = true;
      overlay.remove();
      if (e.status !== 401) toast(e.message, 'err', 6000);
    }
    await ticker;
  }

  // ───────────────────────── RESULTS ─────────────────────────
  const VITALS = [
    ['formatting', 'Formatting', 20, 'var(--violet)'],
    ['keywords', 'Keywords', 25, 'var(--lime)'],
    ['content', 'Content & impact', 25, 'var(--sky)'],
    ['skill_validation', 'Skill evidence', 15, 'var(--amber)'],
    ['ats_compatibility', 'ATS compatibility', 15, 'var(--coral)'],
  ];
  const SEV = { high: 'var(--coral)', moderate: 'var(--amber)', medium: 'var(--amber)', low: 'var(--sky)' };

  function renderResults(r, mount, { fromHistory = false } = {}) {
    const score = Math.round(r.ats_score ?? r.ATS_score ?? 0);
    const cs = r.component_scores || {};
    const jd = r.jd_comparison || r.jd_match_analysis;
    const svd = r.skill_validation_details || { validated: [], unvalidated: [] };
    const cand = r.candidate || {};
    const st = r.stats || {};
    const issues = r.detailed_feedback || [];
    const col = scoreColor(score);
    const years = r.experience_months ? (r.experience_months / 12).toFixed(1) : '0';
    const doneKey = `atsight.todo.${r.id || 'latest'}`;
    let doneSet = new Set(JSON.parse(store.get(doneKey) || '[]'));

    const candChips = [
      cand.email && `✉ ${cand.email}`, cand.phone && `☏ ${cand.phone}`,
      cand.linkedin && 'in · LinkedIn', cand.github && '⌥ GitHub',
    ].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('');

    const sortedIssues = [...issues].sort((a, b) => ['high', 'moderate', 'medium', 'low'].indexOf((a.severity_level || '').toLowerCase()) - ['high', 'moderate', 'medium', 'low'].indexOf((b.severity_level || '').toLowerCase()));

    mount.innerHTML = `
      <div class="results" id="results">
        <div class="print-head">ATSight report — ${esc(r.filename || 'resume')}</div>
        <div class="res-top">
          <div class="crumbs">REPORT · <b>${esc(r.filename || 'resume')}</b> · ${esc(fmtDate(r.created_at))}${r.parser ? ` · parser: ${esc(r.parser)}` : ''}</div>
          <div class="res-actions">
            ${fromHistory ? '<a class="btn btn-sm" href="#/history">← All scans</a>' : ''}
            <button class="btn btn-sm" id="exportBtn">⤓ Export PDF</button>
            <button class="btn btn-sm btn-lime" id="rescanBtn">${fromHistory ? 'New scan' : 'Scan another'} <i class="arrow">→</i></button>
          </div>
        </div>

        <div class="verdict">
          <div class="gauge-card">
            <div class="stamp" style="color:${col}">${grade(score)}</div>
            <div class="gauge">
              <svg viewBox="0 0 300 300">${gaugeSVG(score)}</svg>
              <div class="gauge-center"><div><div class="gauge-num" id="gaugeNum" style="color:${col}">0</div><div class="gauge-lbl">ATS SCORE / 100</div></div></div>
            </div>
          </div>
          <div class="verdict-main">
            <span class="mono tiny dim">// Verdict${cand.name ? ' for ' + esc(cand.name) : ''}</span>
            <h2>${headline(score)}</h2>
            <p class="dim" style="margin:0">${esc(r.interpretation || '')}</p>
            ${candChips ? `<div class="cand">${candChips}</div>` : ''}
            <div class="stat-row">
              <div><b>${st.skills ?? (r.skills || []).length}</b><span>skills</span></div>
              <div><b>${st.projects ?? '–'}</b><span>projects</span></div>
              <div><b>${years}</b><span>yrs exp.</span></div>
              <div><b>${st.action_verbs ?? '–'}</b><span>action verbs</span></div>
              <div><b>${issues.length}</b><span>issues</span></div>
            </div>
          </div>
        </div>

        <div class="grid-2">
          <div class="card reveal">
            <div class="card-h"><h3><span class="idx">01</span>Vitals</h3><span class="meta">weighted breakdown</span></div>
            ${VITALS.map(([k, label, max, c]) => {
              const v = +(cs[k] ?? 0);
              return `<div class="vital"><span class="v-name">${label}</span>${segs((v / max) * 100, c)}<span class="v-val">${v.toFixed(1)}<small>/${max}</small></span></div>`;
            }).join('')}
          </div>

          <div class="card reveal">
            <div class="card-h"><h3><span class="idx">02</span>Job match</h3><span class="meta">${jd?.job_title ? esc(jd.job_title) : ''}</span></div>
            ${jd ? `
              <div class="match-hero">
                <div class="match-ring">${ringSVG(jd.match_percentage, 110, 10, scoreColor(jd.match_percentage))}<div class="num"><span>${Math.round(jd.match_percentage)}<small style="font-size:16px">%</small></span></div></div>
                <div>
                  <div style="font-size:18px;font-weight:600;margin-bottom:4px">${jd.match_percentage >= 70 ? 'Strong fit' : jd.match_percentage >= 50 ? 'Partial fit' : 'Weak fit'} for this role</div>
                  <div class="sim">semantic similarity <b>${(jd.semantic_similarity * 100).toFixed(0)}%</b> · ${jd.matched_keywords.length} matched · ${jd.missing_keywords.length} missing</div>
                </div>
              </div>
              <div class="kw-block"><h5><i style="background:var(--lime)"></i>Found in your resume</h5><div class="kw-list">${jd.matched_keywords.map((k) => `<span class="chip hit">${esc(k)}</span>`).join('') || '<span class="mute">none</span>'}</div></div>
              ${jd.skills_gap?.length ? `<div class="kw-block"><h5><i style="background:var(--amber)"></i>Must-have skills missing</h5><div class="kw-list">${jd.skills_gap.map((k) => `<span class="chip gap">${esc(k)}</span>`).join('')}</div></div>` : ''}
              <div class="kw-block"><h5><i style="background:var(--coral)"></i>Other missing keywords</h5><div class="kw-list">${jd.missing_keywords.filter((k) => !(jd.skills_gap || []).includes(k)).map((k) => `<span class="chip miss">${esc(k)}</span>`).join('') || '<span class="mute">nothing missing 🎯</span>'}</div></div>
            ` : `
              <p class="empty-note">No job description was provided.</p>
              <p class="dim" style="font-size:14px">Paste a JD next time to see matched & missing keywords and a semantic-fit score.</p>
              <div class="kw-block"><h5><i style="background:var(--violet)"></i>Keywords detected in your resume</h5><div class="kw-list">${(r.matched_keywords || r.skills || []).slice(0, 24).map((k) => `<span class="chip">${esc(k)}</span>`).join('')}</div></div>
            `}
          </div>
        </div>

        <div class="card reveal" style="margin-bottom:18px">
          <div class="card-h"><h3><span class="idx">03</span>Skill evidence map</h3>
            <span class="ev-legend"><span><b class="lime">●</b> proven in projects/experience (${svd.validated_count ?? svd.validated.length})</span><span><b style="color:var(--coral)">○</b> claimed only (${svd.unvalidated.length})</span></span></div>
          ${svd.validated.length + svd.unvalidated.length ? `<div class="evidence">
            ${svd.validated.map((v) => `<div class="ev ok"><div class="ev-name">${esc(v.skill)}<span>●</span></div><div class="ev-proof">↳ ${esc((v.projects || []).join(' · '))}</div></div>`).join('')}
            ${svd.unvalidated.map((s) => `<div class="ev no"><div class="ev-name">${esc(s)}<span>○</span></div><div class="ev-proof">no project or role mentions it</div></div>`).join('')}
          </div>` : '<p class="empty-note">No skills were detected.</p>'}
        </div>

        <div class="grid-2">
          <div class="card reveal">
            <div class="card-h"><h3><span class="idx">04</span>What's working</h3><span class="meta">${(r.strengths || []).length} strengths</span></div>
            ${(r.strengths || []).length ? `<ul class="strengths">${r.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p class="empty-note">Let\'s build some strengths — start with the fix-list.</p>'}
          </div>
          <div class="card reveal">
            <div class="card-h"><h3><span class="idx">05</span>Detected skills</h3><span class="meta">${(r.skills || []).length} total</span></div>
            <div class="kw-list">${(r.skills || []).map((k) => `<span class="chip">${esc(k)}</span>`).join('') || '<span class="mute">none</span>'}</div>
          </div>
        </div>

        <div class="card reveal">
          <div class="card-h"><h3><span class="idx">06</span>Fix-list</h3><span class="meta">${sortedIssues.length ? 'tap an issue to expand · tick items as you fix them' : ''}</span></div>
          ${sortedIssues.length ? `<div class="issues">${sortedIssues.map((it, i) => {
            const sev = (it.severity_level || 'low').toLowerCase();
            return `<details class="issue" style="--sev:${SEV[sev] || 'var(--sky)'}" ${i === 0 ? 'open' : ''}>
              <summary>
                <div><h4>${esc(it.issue_title)}</h4><div class="where">${esc(it.where_it_appears)}</div></div>
                <span class="sev">${esc(it.severity_level)}</span><span class="plus">+</span>
              </summary>
              <div class="issue-body">
                <div>
                  <p>${esc(it.explanation)}</p>
                  <h6>How to fix</h6><p>${esc(it.how_to_fix)}</p>
                  <h6>Checklist</h6>
                  <ul class="todo">${(it.action_items || []).map((a, j) => {
                    const key = `${i}:${j}`;
                    return `<li data-key="${key}" class="${doneSet.has(key) ? 'done' : ''}"><span class="box">${doneSet.has(key) ? '✓' : ''}</span><span>${esc(a)}</span></li>`;
                  }).join('')}</ul>
                </div>
                <div><h6>Example</h6><pre class="example">${esc(it.example_improvement)}</pre></div>
              </div>
            </details>`;
          }).join('')}</div>` : `<div class="all-clear"><div class="big">No red flags. <em>Nice.</em></div><p class="dim">Your resume passed every structural check. Tailor keywords per job post to push higher.</p></div>`}
        </div>
      </div>`;

    // animate gauge + number + segments
    requestAnimationFrame(() => {
      const fill = $('.gauge .g-fill', mount);
      if (fill) setTimeout(() => { fill.style.strokeDashoffset = fill.dataset.off; }, 60);
      countUp($('#gaugeNum', mount), score, 1600);
      $$('.segs', mount).forEach((row) => $$('i', row).forEach((cell, idx) => {
        if (cell.dataset.on === '1') setTimeout(() => cell.classList.add('on'), 300 + idx * 45);
      }));
    });

    $$('.todo li', mount).forEach((li) => li.addEventListener('click', () => {
      const k = li.dataset.key;
      li.classList.toggle('done');
      if (li.classList.contains('done')) doneSet.add(k); else doneSet.delete(k);
      $('.box', li).textContent = li.classList.contains('done') ? '✓' : '';
      store.set(doneKey, JSON.stringify([...doneSet]));
    }));
    $('#exportBtn', mount).addEventListener('click', () => window.print());
    $('#rescanBtn', mount).addEventListener('click', () => {
      S.lastResult = null; S.file = null;
      if (location.hash === '#/scan') viewScan(); else location.hash = '#/scan';
    });
    initReveal();
  }

  // print: expand all issue cards
  window.addEventListener('beforeprint', () => $$('details.issue').forEach((d) => { d.dataset.wasOpen = d.open ? '1' : ''; d.open = true; }));
  window.addEventListener('afterprint', () => $$('details.issue').forEach((d) => { d.open = d.dataset.wasOpen === '1'; }));

  // ───────────────────────── HISTORY ─────────────────────────
  async function loadHistory(force) {
    if (!S.history || force) S.history = await api('/history');
    return S.history;
  }

  async function viewHistory() {
    app.innerHTML = `
      <section class="page wrap">
        <div class="page-head">
          <span class="mono tiny dim">// History</span>
          <h1>Your scan<br><em>archive</em>.</h1>
          <p>Every report you've run, saved to your account. Click any card to reopen the full report.</p>
        </div>
        <div id="histMount"><div class="dim mono">loading…</div></div>
      </section>`;
    let items;
    try { items = await loadHistory(true); }
    catch (e) { $('#histMount').innerHTML = `<div class="empty"><h3>Couldn't load history</h3><p>${esc(e.message)}</p></div>`; return; }
    renderHistory(items);
  }

  function renderHistory(items) {
    const mount = $('#histMount');
    if (!mount) return;
    if (!items.length) {
      mount.innerHTML = `<div class="empty"><h3>Nothing here <em class="lime">yet</em>.</h3><p>Run your first scan and it'll show up here.</p><a class="btn btn-lime" href="#/scan">Scan a resume <i class="arrow">→</i></a></div>`;
      return;
    }
    const scores = [...items].reverse().map((i) => Math.round(i.ats_score));
    const best = Math.max(...scores);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const delta = scores.length > 1 ? scores[scores.length - 1] - scores[0] : 0;

    mount.innerHTML = `
      <div class="grid-2">
        <div class="card trend">
          <div class="card-h"><h3><span class="idx">↗</span>Score trend</h3><span class="meta">${scores.length} scans</span></div>
          ${trendSVG(scores)}
        </div>
        <div class="card">
          <div class="card-h"><h3><span class="idx">Σ</span>Summary</h3></div>
          <div class="stat-row" style="grid-template-columns:repeat(3,1fr)">
            <div><b style="color:${scoreColor(best)}">${best}</b><span>best score</span></div>
            <div><b>${avg}</b><span>average</span></div>
            <div><b style="color:${delta >= 0 ? 'var(--lime)' : 'var(--coral)'}">${delta >= 0 ? '+' : ''}${delta}</b><span>first → latest</span></div>
          </div>
        </div>
      </div>
      <div class="hist-grid">
        ${items.map((it) => {
          const s = Math.round(it.ats_score);
          return `<article class="hist reveal" data-id="${esc(it.id)}" tabindex="0">
            <div class="hist-top">
              <div class="hist-ring">${ringSVG(s)}<b style="color:${scoreColor(s)}">${s}</b></div>
              <div style="min-width:0"><h4>${esc(it.filename)}</h4><div class="when">${esc(fmtDate(it.created_at))}</div></div>
            </div>
            <div class="hist-foot">
              <span>${it.job_title ? '◎ ' + esc(it.job_title) : 'no JD'}${it.keyword_match ? ` · ${Math.round(it.keyword_match)}% match` : ''}</span>
              <button class="icon-btn" data-del="${esc(it.id)}" aria-label="Delete scan">✕</button>
            </div>
          </article>`;
        }).join('')}
      </div>`;

    $$('.hist', mount).forEach((card) => {
      const open = () => { location.hash = `#/report/${card.dataset.id}`; };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    });
    $$('[data-del]', mount).forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this scan permanently?')) return;
      try {
        await api(`/history/${b.dataset.del}`, { method: 'DELETE' });
        S.history = S.history.filter((h) => h.id !== b.dataset.del);
        renderHistory(S.history);
        toast('Scan deleted');
      } catch (ex) { toast(ex.message, 'err'); }
    }));
    initReveal();
  }

  function trendSVG(scores) {
    const W = 600, H = 150, P = 12;
    if (scores.length === 1) scores = [scores[0], scores[0]];
    const x = (i) => P + (i / (scores.length - 1)) * (W - 2 * P);
    const y = (v) => H - P - (v / 100) * (H - 2 * P);
    const pts = scores.map((v, i) => `${x(i)},${y(v)}`);
    const grid = [25, 50, 75].map((g) => `<line x1="0" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="var(--line)" stroke-dasharray="3 5"/><text x="${W}" y="${y(g) - 4}" text-anchor="end" fill="var(--paper-mute)" font-family="Geist Mono" font-size="10">${g}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#c8ff2e" stop-opacity=".35"/><stop offset="1" stop-color="#c8ff2e" stop-opacity="0"/></linearGradient></defs>
      ${grid}
      <polygon points="${x(0)},${H - P} ${pts.join(' ')} ${x(scores.length - 1)},${H - P}" fill="url(#tg)"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="var(--lime)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      ${scores.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="var(--ink)" stroke="var(--lime)" stroke-width="2" vector-effect="non-scaling-stroke"><title>${v}</title></circle>`).join('')}
    </svg>`;
  }

  async function viewReport(id) {
    app.innerHTML = `<section class="page wrap"><div id="reportMount"><div class="dim mono">loading report…</div></div></section>`;
    try {
      const items = await loadHistory();
      const hit = items.find((i) => i.id === id);
      if (!hit) throw new Error('This report no longer exists.');
      const r = { ...hit.analysis_result, id: hit.id, filename: hit.filename, created_at: hit.created_at };
      renderResults(r, $('#reportMount'), { fromHistory: true });
    } catch (e) {
      $('#reportMount').innerHTML = `<div class="empty"><h3>Report not found</h3><p>${esc(e.message)}</p><a class="btn" href="#/history">← Back to history</a></div>`;
    }
  }

  // ───────────────────────── PLAYBOOK ─────────────────────────
  function viewPlaybook() {
    const verbs = ['Architected', 'Automated', 'Built', 'Cut', 'Deployed', 'Designed', 'Drove', 'Engineered', 'Grew', 'Launched', 'Led', 'Migrated', 'Optimized', 'Reduced', 'Scaled', 'Shipped', 'Spearheaded', 'Streamlined'];
    app.innerHTML = `
      <section class="page wrap">
        <div class="page-head">
          <span class="mono tiny dim">// Playbook</span>
          <h1>The rules the<br><em>bots</em> play by.</h1>
          <p>Field-tested guidance for getting past applicant-tracking systems — and impressing the human on the other side.</p>
        </div>

        <div class="card reveal" style="margin-bottom:18px">
          <div class="card-h"><h3><span class="idx">★</span>The bullet-point formula</h3></div>
          <p class="formula"><span class="f1">Action verb</span> + <span class="f2">what you built</span> + <span class="f3">measurable result</span></p>
          <pre class="example" style="margin-top:20px">✕  Responsible for the search feature.
✓  Built a RAG search pipeline over 20K docs with FAISS, cutting lookup time by 60%.</pre>
        </div>

        <div class="play-grid">
          <div class="card do reveal">
            <div class="card-h"><h3>✓ Do</h3></div>
            <ol class="rule-list">
              <li><div><b>Mirror the job post</b><span>Use the exact skill names the JD uses — "PostgreSQL", not just "SQL databases".</span></div></li>
              <li><div><b>Standard section headings</b><span>Summary, Experience, Projects, Education, Skills. ATS parsers look for these words.</span></div></li>
              <li><div><b>Quantify everything</b><span>Users, %, ms, $, team size. Numbers are the fastest proof of impact.</span></div></li>
              <li><div><b>Prove every skill</b><span>Each skill in your list should appear in at least one project or role.</span></div></li>
              <li><div><b>Single column, text-based PDF</b><span>Export from Word/Docs — never a scanned image.</span></div></li>
            </ol>
          </div>
          <div class="card dont reveal">
            <div class="card-h"><h3>✕ Don't</h3></div>
            <ol class="rule-list">
              <li><div><b>Tables, text boxes, columns</b><span>Parsers read them out of order — or skip them entirely.</span></div></li>
              <li><div><b>Contact info in headers/footers</b><span>Many ATS ignore header/footer regions.</span></div></li>
              <li><div><b>Keyword stuffing</b><span>Recruiters notice. Weave keywords into real accomplishments instead.</span></div></li>
              <li><div><b>"Responsible for…"</b><span>Describes a job, not an achievement. Lead with a verb.</span></div></li>
              <li><div><b>Full street address</b><span>City + country is enough; the rest is a privacy risk.</span></div></li>
            </ol>
          </div>
        </div>

        <div class="grid-2" style="margin-top:18px">
          <div class="card reveal">
            <div class="card-h"><h3><span class="idx">⚡</span>Power verbs</h3></div>
            <div class="verbs">${verbs.map((v) => `<span class="chip hit">${v}</span>`).join('')}</div>
          </div>
          <div class="card reveal">
            <div class="card-h"><h3><span class="idx">◎</span>How your score is built</h3></div>
            ${VITALS.map(([, label, max, c]) => `<div class="vital"><span class="v-name">${label}</span>${segs((max / 25) * 100, c).replace(/data-on="1"/g, 'class="on" data-on="1"')}<span class="v-val">${max}<small> pts</small></span></div>`).join('')}
          </div>
        </div>

        <div class="cta-band reveal" style="margin-bottom:0">
          <h2>Theory's done.<br><em class="lime">Test it.</em></h2>
          <button class="btn btn-lime btn-scan" id="playCta"><span>Scan my resume</span><i class="arrow">→</i></button>
        </div>
      </section>`;
    $('#playCta').addEventListener('click', goScan);
  }

  // ───────────────────────── effects ─────────────────────────
  let revealObs;
  function initReveal() {
    if (!('IntersectionObserver' in window)) { $$('.reveal').forEach((el) => el.classList.add('in')); return; }
    revealObs?.disconnect();
    revealObs = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('in'); revealObs.unobserve(en.target); }
    }), { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    $$('.reveal:not(.in)').forEach((el, i) => { el.style.transitionDelay = `${(i % 4) * 70}ms`; revealObs.observe(el); });
  }

  function initCursorGlow() {
    const g = $('.cursor-glow');
    if (matchMedia('(pointer: coarse)').matches) { g.style.display = 'none'; return; }
    let tx = innerWidth / 2, ty = innerHeight * .3, x = tx, y = ty;
    addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; });
    const loop = () => { x += (tx - x) * .08; y += (ty - y) * .08; g.style.left = x + 'px'; g.style.top = y + 'px'; requestAnimationFrame(loop); };
    loop();
  }

  // ───────────────────────── boot ─────────────────────────
  async function boot() {
    $('#burger').addEventListener('click', () => $('#nav').classList.toggle('open'));
    bindAuthModal();
    initCursorGlow();
    renderNav();
    // Talk to the backend in the background — the free Render server may be asleep (~1 min wake-up),
    // so the page must never wait on it to render.
    const slow = setTimeout(() => toast('Waking up the server — the first load can take up to a minute…', 'ok', 8000), 3500);
    S.ready = (async () => {
      try { S.config = await api('/config', { auth: false }); } catch { S.config = {}; }
      await restoreSession();
    })().finally(() => { clearTimeout(slow); S.booted = true; renderNav(); });
    addEventListener('hashchange', route);
    route();
  }
  boot();
})();
