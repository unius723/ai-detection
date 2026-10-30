// Node 18+ server. Locally it uses JSONL; set DATABASE_URL to use PostgreSQL/Neon.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, PASS = process.env.ADMIN_PASSWORD || '';
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data'), LOG = path.join(DIR, 'events.jsonl');
const DATABASE_URL = process.env.DATABASE_URL || '';
// Use the existing image folders; filenames and extensions do not need to change.
// Each colour stimulus may have a companion grayscale file named <base>_gray.<ext> in the same folder.
const images = [];
for (const category of ['portrait', 'landscape']) for (const truth of ['real', 'ai']) {
  const folder = path.join(__dirname, 'image', category, truth === 'ai' ? 'AI' : 'real');
  if (!fs.existsSync(folder)) continue;
  const files = fs.readdirSync(folder).filter(f => /\.(jpe?g|png|webp)$/i.test(f) && fs.statSync(path.join(folder, f)).isFile()).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const file of files) {
    if (/_gray\./i.test(file)) continue; // grayscale companion is not an independent stimulus
    const base = file.replace(/\.[^.]+$/, '');
    const gray = files.find(f => f !== file && f.replace(/\.[^.]+$/, '').toLowerCase() === (base + '_gray').toLowerCase());
    images.push({ id: `${category}_${truth}_${images.filter(i => i.cat === category && i.truth === truth).length + 1}`, filename: file, grayFilename: gray || null,
      src: '/image/' + [category, truth === 'ai' ? 'AI' : 'real', file].map(encodeURIComponent).join('/'),
      gray: gray ? '/image/' + [category, truth === 'ai' ? 'AI' : 'real', gray].map(encodeURIComponent).join('/') : null,
      cat: category, truth, realism: '' });
  }
}
const catalog = new Map(images.map(i => [i.id, i]));
if (!DATABASE_URL) fs.mkdirSync(DIR, { recursive: true });
if (!PASS) console.warn('! ADMIN_PASSWORD is not set: the /admin dashboard is disabled.');

/* ---------- storage: Neon Postgres in production; JSONL fallback for local testing ---------- */
let events = [], pool;
const tokens = new Map(), plans = new Map(), seen = new Set(), done = new Set(); let counter = 0;
function index(e) {
  if (e.type === 'counter') counter = Math.max(counter, e.value);
  if (e.type === 'start') { tokens.set(e.pid, e.token); plans.set(e.pid, e.plan); counter = Math.max(counter, +(e.pid.match(/\d+$/) || [0])[0]); }
  if (e.type === 'trial') seen.add(e.pid + ':' + e.trial.trial);
  if (e.type === 'finish') done.add(e.pid);
}
async function initStorage() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
    await pool.query('CREATE TABLE IF NOT EXISTS study_events (id BIGSERIAL PRIMARY KEY, event JSONB NOT NULL)');
    const result = await pool.query('SELECT event FROM study_events ORDER BY id');
    events = result.rows.map(row => row.event);
    console.log('Using PostgreSQL storage. Loaded ' + events.length + ' events.');
  } else {
    events = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    console.log('Using local JSONL storage. Loaded ' + events.length + ' events.');
  }
  events.forEach(index);
}
async function add(e) {
  e.t = new Date().toISOString();
  if (pool) await pool.query('INSERT INTO study_events (event) VALUES ($1::jsonb)', [JSON.stringify(e)]);
  else fs.appendFileSync(LOG, JSON.stringify(e) + '\n');
  events.push(e); index(e);
}
async function deleteParticipant(pid) {
  if (!tokens.has(pid)) return false;
  // Retain only the ID high-water mark so deleted IDs are never reused after restart.
  const remaining = events.filter(e => e.pid !== pid && e.type !== 'counter');
  remaining.push({ type: 'counter', value: counter });
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("DELETE FROM study_events WHERE event->>'pid' = $1 OR event->>'type' = 'counter'", [pid]);
      await client.query('INSERT INTO study_events (event) VALUES ($1::jsonb)', [JSON.stringify(remaining[remaining.length - 1])]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
  } else {
    const tmp = path.join(DIR, 'events-' + crypto.randomBytes(8).toString('hex') + '.tmp');
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, remaining.map(e => JSON.stringify(e)).join('\n') + '\n');
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, LOG);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
  // Update memory only after the replacement file has been saved successfully.
  events = remaining; tokens.delete(pid); plans.delete(pid); done.delete(pid);
  for (const key of seen) if (key.startsWith(pid + ':')) seen.delete(key);
  return true;
}

// Serialize mutations so participant numbers and event ordering stay deterministic.
let writeTail = Promise.resolve();
function serialWrite(fn) {
  const task = writeTail.then(fn, fn);
  writeTail = task.catch(() => {});
  return task;
}

/* ---------- helpers ---------- */
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e5) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { no(e); } }); });
const sha = s => crypto.createHash('sha256').update(s).digest();

/* ---------- participant API ---------- */
async function api(p, b, res) {
  if (p === '/api/start') {
    if (!images.length || !Array.isArray(b.plan) || b.plan.length !== images.length ||
      new Set(b.plan.map(x => x.image)).size !== images.length ||
      b.plan.some(x => !catalog.has(x.image) || !['color', 'gray'].includes(x.colour))) return json(res, 400, { error: 'invalid image plan' });
    return serialWrite(async () => {
      const pid = 'PD' + String(++counter).padStart(3, '0'), token = crypto.randomBytes(8).toString('hex');
      const d = b.device || {};
      try {
        await add({ type: 'start', pid, token, major: str(b.major, 60),
          plan: b.plan.map(x => ({ image: x.image, colour: x.colour })),
          device: { w: +d.w || 0, h: +d.h || 0, ua: str(d.ua, 200), tz: str(d.tz, 40) } });
      } catch (e) { counter--; throw e; }
      return json(res, 200, { pid, token });
    });
  }
  if (!tokens.has(b.pid) || tokens.get(b.pid) !== b.token) return json(res, 403, { error: 'invalid session' });
  if (p === '/api/trial') {
    const t = b.trial || {}, n = +t.trial;
    const plan = plans.get(b.pid), expected = plan[n - 1], stimulus = expected && catalog.get(expected.image);
    const reason = str(t.reason, 200).trim();
    if (!Number.isInteger(n) || !stimulus || t.image !== expected.image || t.colour !== expected.colour || !['real', 'ai'].includes(t.response) || !Number.isInteger(+t.confidence) || !(+t.confidence >= 1 && +t.confidence <= 5)) return json(res, 400, { error: 'bad trial' });
    if (done.has(b.pid)) return json(res, 409, { error: 'session already completed' });
    // Revisited questions append a new event; aggregation keeps the latest answer for each trial.
    await serialWrite(() => add({ type: 'trial', pid: b.pid, trial: {
      trial: n, image: stimulus.id, filename: expected.colour === 'gray' && stimulus.grayFilename ? stimulus.grayFilename : stimulus.filename,
      category: stimulus.cat, truth: stimulus.truth, ai_realism: stimulus.realism,
      colour: expected.colour, response: t.response, correct: t.response === stimulus.truth ? 1 : 0, confidence: +t.confidence,
      reason, rt_choice_ms: +t.rt_choice_ms || 0, rt_total_ms: +t.rt_total_ms || 0, shown_at: str(t.shown_at, 40) } }));
    return json(res, 200, { ok: 1 });
  }
  if (p === '/api/finish') {
    const total = plans.get(b.pid).length;
    const isPercent = Object.hasOwn(b, 'estimatePercent');
    // Keep accepting count-based submissions from pages opened before this update.
    if (isPercent ? ![0, 25, 50, 75, 100].includes(b.estimatePercent) :
      (b.estimate == null || !Number.isInteger(+b.estimate) || +b.estimate < 0 || +b.estimate > total)) return json(res, 400, { error: 'bad estimate' });
    if (Array.from({ length: total }, (_, i) => i + 1).some(n => !seen.has(b.pid + ':' + n))) return json(res, 409, { error: 'trials still missing' });
    if (!done.has(b.pid)) await serialWrite(() => add({ type: 'finish', pid: b.pid,
      ...(isPercent ? { estimatePercent: b.estimatePercent } : { estimate: +b.estimate }), clientSec: +b.clientSec || 0 }));
    return json(res, 200, { ok: 1 });
  }
  json(res, 404, { error: 'not found' });
}

/* ---------- admin: aggregation + CSV ---------- */
function build() {
  const m = new Map();
  for (const e of events) {
    if (e.type === 'start') m.set(e.pid, { pid: e.pid, major: e.major, startedAt: e.t, device: e.device, total: e.plan.length, trials: [], trialMap: new Map(), status: 'in progress' });
    const q = m.get(e.pid); if (!q) continue;
    if (e.type === 'trial') q.trialMap.set(e.trial.trial, e.trial);
    if (e.type === 'finish') Object.assign(q, { status: 'completed', finishedAt: e.t,
      estimate: e.estimatePercent == null ? e.estimate : e.estimatePercent * q.total / 100,
      estimatePercent: e.estimatePercent == null ? e.estimate / q.total * 100 : e.estimatePercent, clientSec: e.clientSec });
  }
  const acc = (q, f) => { const r = q.trials.filter(f); return r.length ? +(r.reduce((s, x) => s + x.correct, 0) / r.length).toFixed(3) : null; };
  for (const q of m.values()) {
    q.trials = [...q.trialMap.values()]; delete q.trialMap;
    q.trials.sort((a, b) => a.trial - b.trial);
    q.correct = q.trials.reduce((s, x) => s + x.correct, 0);
    q.gapPercent = q.estimatePercent == null ? null : +(q.estimatePercent - q.correct / q.total * 100).toFixed(1);
    q.accAll = acc(q, () => 1); q.accColor = acc(q, x => x.colour === 'color'); q.accGray = acc(q, x => x.colour === 'gray');
    q.accPortrait = acc(q, x => x.category === 'portrait'); q.accLandscape = acc(q, x => x.category === 'landscape');
    q.durationSec = q.finishedAt ? Math.round((new Date(q.finishedAt) - new Date(q.startedAt)) / 1000) : null;
  }
  return [...m.values()];
}
const cell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }; // also blocks spreadsheet formula injection
const csv = (head, rows) => '\ufeff' + head.join(',') + '\n' + rows.map(r => head.map(h => cell(r[h])).join(',')).join('\n');
function csvParticipants() {
  const rows = build().map(q => ({ participant_id: q.pid, major: q.major, status: q.status, started_at: q.startedAt, finished_at: q.finishedAt, duration_sec: q.durationSec,
    client_duration_sec: q.clientSec, trials_total: q.total, trials_done: q.trials.length, correct: q.correct, acc_all: q.accAll, acc_colour: q.accColor, acc_gray: q.accGray,
    acc_portrait: q.accPortrait, acc_landscape: q.accLandscape, self_estimate: q.estimate, estimate_minus_actual: q.estimate == null ? '' : q.estimate - q.correct,
    self_estimate_percent: q.estimatePercent, estimate_minus_actual_pp: q.gapPercent,
    viewport: q.device.w + 'x' + q.device.h, timezone: q.device.tz, user_agent: q.device.ua }));
  return csv(Object.keys(rows[0] || { participant_id: 1 }), rows);
}
function csvTrials() {
  const rows = []; for (const q of build()) for (const t of q.trials) rows.push({ participant_id: q.pid, major: q.major, ...t });
  return csv(['participant_id', 'major', 'trial', 'image', 'filename', 'category', 'truth', 'ai_realism', 'colour', 'response', 'correct', 'confidence', 'reason', 'rt_choice_ms', 'rt_total_ms', 'shown_at'], rows);
}
function authed(req) {
  const h = req.headers.authorization || '';
  if (!PASS || !h.startsWith('Basic ')) return false;
  const pw = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return crypto.timingSafeEqual(sha(pw), sha(PASS));
}
async function admin(req, res, p) {
  if (!PASS) { res.writeHead(403); return res.end('Set ADMIN_PASSWORD and restart the server.'); }
  if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Study admin"' }); return res.end('Login required'); }
  const participant = p.match(/^\/admin\/participants\/(PD?\d+)$/);
  if (participant) {
    if (req.method !== 'DELETE') { res.setHeader('Allow', 'DELETE'); return json(res, 405, { error: 'method not allowed' }); }
    // A cross-origin page cannot send this header without a CORS preflight, which we do not allow.
    if (req.headers['x-study-admin'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'invalid admin request' });
    try {
      if (!await serialWrite(() => deleteParticipant(participant[1]))) return json(res, 404, { error: 'participant not found' });
      return json(res, 200, { ok: 1 });
    } catch (e) {
      console.error('Could not save participant deletion:', e.message);
      return json(res, 500, { error: 'could not save deletion' });
    }
  }
  if (p === '/admin') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'admin.html'))); }
  if (p === '/analysis') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'analysis.html'))); }
  if (p === '/admin/data' || p === '/analysis/data') return json(res, 200, build());
  if (p === '/admin/participants.csv' || p === '/admin/trials.csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=' + p.split('/').pop() });
    return res.end(p.includes('participants') ? csvParticipants() : csvTrials());
  }
  res.writeHead(404); res.end('Not found');
}

/* ---------- static files ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript' };
function serve(p, res) {
  if (p === '/') p = '/index.html';
  // Serve only the participant page and catalog images (including grayscale companions), never code or response data.
  if (p !== '/index.html' && !images.some(i => i.src === p || i.gray === p)) { res.writeHead(404); return res.end('Not found'); }
  const f = path.join(__dirname, decodeURIComponent(p));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  const headers = { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
  if (p.startsWith('/image/')) headers['Cache-Control'] = 'public, max-age=3600';
  res.writeHead(200, headers);
  fs.createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, { images });
    if (req.method === 'POST' && p.startsWith('/api/')) return await api(p, await readBody(req), res);
    if (p.startsWith('/admin') || p.startsWith('/analysis')) return await admin(req, res, p);
    serve(p, res);
  } catch (e) { json(res, 400, { error: 'bad request' }); }
});

initStorage().then(() => {
  server.listen(PORT, BIND_HOST, () => console.log('Loaded ' + images.length + ' images. Study: http://' + BIND_HOST + ':' + PORT + '   Admin: http://' + BIND_HOST + ':' + PORT + '/admin'));
}).catch(e => {
  console.error('Storage initialization failed:', e.message);
  process.exitCode = 1;
});
