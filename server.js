import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import fetch from 'node-fetch';
import { buildAndCleanAddress } from './lib/addressCleaner.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_KML_PATH = path.join(__dirname, 'address-plotter-export.kml');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const LIST_MYMAPS = path.join(SCRIPTS_DIR, 'list-mymaps.mjs');
const IMPORT_MYMAPS = path.join(SCRIPTS_DIR, 'import-to-mymaps.mjs');
const CREATE_MYMAP = path.join(SCRIPTS_DIR, 'create-mymap.mjs');
const LAUNCH_AUTH_BROWSER = path.join(SCRIPTS_DIR, 'launch-auth-browser.mjs');

// Environment for child processes (Playwright scripts) - inherit DISPLAY and BROWSER_USER_DATA_DIR
const childEnv = { ...process.env };

const MYMAPS_IMPORT_TIMEOUT_MS = parseInt(process.env.MYMAPS_IMPORT_TIMEOUT_MS || '300000', 10);

// Track if auth browser is currently running
let authBrowserProcess = null;

/**
 * Launch a visible browser for Google re-authentication.
 * Only launches if not already running.
 */
function launchAuthBrowser() {
  // Kill any existing auth browser first
  if (authBrowserProcess) {
    try { authBrowserProcess.kill('SIGTERM'); } catch (_) {}
    authBrowserProcess = null;
  }
  
  console.log('[server] Launching authentication browser...');
  
  authBrowserProcess = spawn('node', [LAUNCH_AUTH_BROWSER], {
    cwd: __dirname,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    detached: false,
  });
  
  authBrowserProcess.stdout.on('data', (chunk) => {
    console.log('[auth-browser]', chunk.toString().trim());
  });
  authBrowserProcess.stderr.on('data', (chunk) => {
    console.error('[auth-browser]', chunk.toString().trim());
  });
  authBrowserProcess.on('close', (code) => {
    console.log(`[server] Auth browser closed with code ${code}`);
    authBrowserProcess = null;
  });
  authBrowserProcess.on('error', (err) => {
    console.error('[server] Auth browser error:', err.message);
    authBrowserProcess = null;
  });
}

/**
 * Check if error message indicates Google session expiry.
 */
function isSessionExpiredError(errorMsg) {
  if (!errorMsg) return false;
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes('session expired') ||
    lower.includes('sign in required') ||
    lower.includes('verify it') ||
    lower.includes('re-authenticate')
  );
}

const SHARED_SECRET = process.env.SHARED_SECRET || '';
const AUTH_COOKIE = 'address-plotter-auth';
const AUTH_TOKEN = SHARED_SECRET
  ? crypto.createHmac('sha256', SHARED_SECRET).update('login').digest('hex')
  : '';

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(';').map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i).trim(), (s.slice(i + 1) || '').trim()];
    })
  );
}

function requireAuth(req, res, next) {
  if (!SHARED_SECRET) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[AUTH_COOKIE] === AUTH_TOKEN) return next();
  if (req.path === '/login' || req.path === '/login.html' || req.path.startsWith('/api/login')) return next();
  if (req.method === 'POST' && req.path === '/api/login') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login.html');
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(requireAuth);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Login: POST /api/login { secret: "..." }
app.post('/api/login', express.json(), (req, res) => {
  const secret = (req.body && req.body.secret) || '';
  if (!SHARED_SECRET) return res.status(400).json({ error: 'Auth not configured' });
  if (secret !== SHARED_SECRET) return res.status(401).json({ error: 'Invalid secret' });
  res.cookie(AUTH_COOKIE, AUTH_TOKEN, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
  res.json({ ok: true });
});

// Config for frontend (e.g. hide My Maps automation when not available)
app.get('/api/config', (req, res) => {
  res.json({ automationAvailable: true });
});

// Launch authentication browser (for manual re-auth or debugging)
app.post('/api/launch-auth', (req, res) => {
  launchAuthBrowser();
  res.json({ ok: true, message: 'Authentication browser launched. Connect via noVNC to complete login.' });
});

const NOMINATIM_DELAY_MS = 1100; // 1 req/sec (Nominatim usage policy)
const USER_AGENT = 'AddressPlotter/1.0 (local CSV geocoding tool)';
const GOOGLE_API_KEY = process.env.GOOGLE_GEOCODING_API_KEY || '';

// Cache geocode results (Nominatim policy requires caching; also speeds up duplicate addresses)
const geocodeCache = new Map();

function cacheKey(query) {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function geocodeWithGoogle(query) {
  const q = encodeURIComponent(query);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${GOOGLE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return { lat: null, lng: null, display_name: null };
  const data = await res.json();
  if (data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
    return { lat: null, lng: null, display_name: null };
  }
  const [first] = data.results;
  const loc = first.geometry?.location;
  return {
    lat: loc ? parseFloat(loc.lat) : null,
    lng: loc ? parseFloat(loc.lng) : null,
    display_name: first.formatted_address || null,
  };
}

async function geocodeWithNominatim(query) {
  const q = encodeURIComponent(query);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) return { lat: null, lng: null, display_name: null };
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return { lat: null, lng: null, display_name: null };
  const [first] = data;
  return {
    lat: parseFloat(first.lat),
    lng: parseFloat(first.lon),
    display_name: first.display_name || null,
  };
}

async function geocodeOne(query) {
  const key = cacheKey(query);
  const cached = geocodeCache.get(key);
  if (cached !== undefined) return cached;

  const result = GOOGLE_API_KEY
    ? await geocodeWithGoogle(query)
    : await geocodeWithNominatim(query);

  geocodeCache.set(key, result);
  return result;
}

// Parse CSV upload — tolerate BOM, inconsistent columns, and common encodings
app.post('/api/parse', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    let text = req.file.buffer.toString('utf-8');
    // Strip BOM (Excel and others often add it)
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
    });
    const headers = rows.length ? Object.keys(rows[0]) : [];
    const filename = req.file.originalname || req.file.name || 'upload.csv';
    res.json({ headers, rows, filename });
  } catch (e) {
    res.status(400).json({
      error: 'Invalid CSV',
      detail: e.message || String(e),
    });
  }
});

// Save KML to project root for the add-to-mymaps script. Body: { kml: string }
app.post('/api/save-kml', (req, res) => {
  const { kml } = req.body || {};
  if (typeof kml !== 'string') return res.status(400).json({ error: 'Missing kml string' });
  try {
    fs.writeFileSync(EXPORT_KML_PATH, kml, 'utf-8');
    res.json({ ok: true, path: EXPORT_KML_PATH });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clean and geocode rows. Body: { rows, addressKeys?, state? }
app.post('/api/clean-and-geocode', async (req, res) => {
  const { rows = [], addressKeys, state = 'MI' } = req.body;
  if (!rows.length) return res.status(400).json({ error: 'No rows' });

  const keys = addressKeys && addressKeys.length ? addressKeys : ['Address1', 'Address2', 'Address3', 'Address4', 'Town', 'County', 'Postcode'];
  const useGoogle = !!GOOGLE_API_KEY;

  if (useGoogle) {
    // Google: all rows in parallel (limit 3k/min; you're under 1k rows)
    const out = await Promise.all(
      rows.map(async (row) => {
        const cleanedAddress = buildAndCleanAddress(row, keys, state);
        if (!cleanedAddress) {
          return { ...row, cleanedAddress: '', lat: null, lng: null, display_name: null };
        }
        const { lat, lng, display_name } = await geocodeOne(cleanedAddress);
        return { ...row, cleanedAddress, lat, lng, display_name };
      })
    );
    return res.json({ rows: out });
  }

  // Nominatim: sequential with 1 req/sec when hitting API
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cleanedAddress = buildAndCleanAddress(row, keys, state);
    if (!cleanedAddress) {
      out.push({ ...row, cleanedAddress: '', lat: null, lng: null, display_name: null });
      continue;
    }
    const key = cacheKey(cleanedAddress);
    const wasCached = geocodeCache.has(key);
    const { lat, lng, display_name } = await geocodeOne(cleanedAddress);
    out.push({ ...row, cleanedAddress, lat, lng, display_name });
    if (!wasCached && i < rows.length - 1) await sleep(NOMINATIM_DELAY_MS);
  }
  res.json({ rows: out });
});

// Run list-mymaps script and return map list (for in-app picker). Browser will open briefly.
app.get('/api/mymaps-list', (req, res) => {
  const child = spawn('node', [LIST_MYMAPS], {
    cwd: __dirname,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  let stdout = '';
  let stderr = '';
  let responded = false;
  function respond(body, isError = false) {
    if (responded) return;
    responded = true;
    if (isError) res.status(500).json(body);
    else res.json(body);
  }
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => {
    if (responded) return;
    if (code !== 0) {
      const msg = stderr?.trim() || 'Failed to list maps';
      // Check if this is a session expiry - launch auth browser
      if (isSessionExpiredError(msg) || isSessionExpiredError(stdout)) {
        launchAuthBrowser();
      }
      const hint = ' You can enter your map ID manually below (from the My Maps URL: .../edit?mid=XXXXX).';
      return respond({ error: msg + hint, maps: [] }, true);
    }
    // Script writes one JSON line; on VPS there may be extra stdout, so find a line that looks like [...]
    const lines = stdout.trim().split('\n').filter((s) => s.trim().startsWith('['));
    const line = lines.length ? lines[lines.length - 1] : '[]';
    try {
      const maps = JSON.parse(line);
      respond({ maps: Array.isArray(maps) ? maps : [] });
    } catch (e) {
      respond({ error: 'Invalid map list output', maps: [] }, true);
    }
  });
  child.on('error', (err) => {
    if (!responded) respond({ error: err.message, maps: [] }, true);
  });
  // If script hangs (e.g. browser never closes), respond after 90s so app can retry
  req.setTimeout(90000, () => {
    if (responded) return;
    try { child.kill('SIGTERM'); } catch (_) {}
    respond({ error: 'Timed out waiting for maps list. Try again.', maps: [] }, true);
  });
});

// Create a new My Map. Body: { name?: string }
app.post('/api/mymaps-create', (req, res) => {
  const { name } = req.body || {};
  const mapName = (name && typeof name === 'string') ? name : 'Untitled map';

  const child = spawn('node', [CREATE_MYMAP, mapName], {
    cwd: __dirname,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  let stdout = '';
  let stderr = '';
  let responded = false;

  function respond(body, isError = false) {
    if (responded) return;
    responded = true;
    if (isError) res.status(500).json(body);
    else res.json(body);
  }

  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => {
    if (responded) return;
    if (code !== 0) {
      const msg = stderr?.trim() || 'Failed to create map';
      // Check if this is a session expiry - launch auth browser
      if (isSessionExpiredError(msg)) {
        launchAuthBrowser();
      }
      return respond({ error: msg }, true);
    }
    // Script outputs JSON with { mid, title }
    const lines = stdout.trim().split('\n').filter((s) => s.trim().startsWith('{'));
    const line = lines.length ? lines[lines.length - 1] : '{}';
    try {
      const result = JSON.parse(line);
      if (!result.mid) throw new Error('No map ID returned');
      respond(result);
    } catch (e) {
      respond({ error: 'Invalid create-map output: ' + (e.message || '') }, true);
    }
  });
  child.on('error', (err) => respond({ error: err.message }, true));
  req.setTimeout(90000);
});

// Run import-to-mymaps script with chosen map ID. Browser will open and import.
app.post('/api/mymaps-import', (req, res) => {
  const { mid, layerName } = req.body || {};
  if (!mid || typeof mid !== 'string') return res.status(400).json({ error: 'Missing map id (mid)' });
  if (!fs.existsSync(EXPORT_KML_PATH)) return res.status(400).json({ error: 'KML not saved. Click "Add to Google My Maps" first.' });

  // Args: mid, kmlPath, layerName
  const args = [IMPORT_MYMAPS, mid, EXPORT_KML_PATH, layerName || ''];
  const child = spawn('node', args, {
    cwd: __dirname,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => {
    if (code !== 0) {
      const msg = stderr || 'Import failed';
      // Check if this is a session expiry - launch auth browser
      if (isSessionExpiredError(msg)) {
        launchAuthBrowser();
      }
      return res.status(500).json({ error: msg });
    }
    res.json({ ok: true });
  });
  child.on('error', (err) => res.status(500).json({ error: err.message }));
  req.setTimeout(MYMAPS_IMPORT_TIMEOUT_MS);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Address Plotter at http://localhost:${PORT}`));
