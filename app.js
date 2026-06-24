import express from 'express';
import { getStore } from './store.js';
import { evaluate } from './rules.js';
import { DASHBOARD_HTML, MONITOR_HTML, HOWITWORKS_HTML } from './dashboard.js';

export const app = express();
app.use(express.json());

// Dashboard auth. Everything is gated behind a password EXCEPT:
//   - /api/webhook : the vendor can't log in; it authenticates with its token
//   - /api/health  : public liveness check
// If DASHBOARD_PASSWORD is unset (local dev), auth is disabled.
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
app.use((req, res, next) => {
  // Public (not behind the dashboard login):
  //   - the webhook (token-auth, for the vendor/factory to POST tags)
  //   - the read-only monitor page + its data API (token-gated, for factory testing)
  //   - health
  if (req.path.startsWith('/api/webhook') || req.path === '/api/health' ||
      req.path.startsWith('/monitor') || req.path.startsWith('/api/monitor') ||
      req.path === '/tracking-animation.svg' || req.path === '/how-it-works' ||
      req.path === '/robots.txt' || req.path === '/sitemap.xml') return next();
  if (!DASHBOARD_PASSWORD) return next();
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const i = decoded.indexOf(':');
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    // If a username is configured, require it too; otherwise accept any username.
    if ((!DASHBOARD_USER || user === DASHBOARD_USER) && pass === DASHBOARD_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="ToolTrace"').status(401).send('Authentication required');
});

// Dashboard — served from the function (after auth), not as a CDN static file,
// so the password actually protects it.
app.get('/', (req, res) => res.type('html').send(DASHBOARD_HTML));

// Brand "live tracking" animation (public). Embed anywhere with:
//   <img src="/tracking-animation.svg" alt="Live tracking" width="320" height="320">
// Recolour by swapping the hex values below.
const TRACKING_SVG = `<svg viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Localizit live tracking">
  <defs>
    <linearGradient id="lz-bg" x1="0" y1="0" x2="240" y2="240" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0284C7" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#05080f"/>
    </linearGradient>
    <pattern id="lz-grid" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="rgba(255,255,255,0.10)"/>
    </pattern>
    <style>
      .lz-route { stroke-dasharray: 3 7; animation: lz-dash 0.9s linear infinite; }
      @keyframes lz-dash { to { stroke-dashoffset: -24; } }
      .lz-ripple, .lz-ripple2 { transform-box: fill-box; transform-origin: center; animation: lz-ripple 2.6s ease-out infinite; }
      .lz-ripple2 { animation-delay: 1.3s; }
      @keyframes lz-ripple { 0% { opacity: .75; transform: scale(.55); } 100% { opacity: 0; transform: scale(1.4); } }
      .lz-blink { animation: lz-blink 1.5s steps(1, end) infinite; }
      @keyframes lz-blink { 0%, 100% { opacity: 1; } 50% { opacity: .12; } }
      @media (prefers-reduced-motion: reduce) { .lz-route, .lz-ripple, .lz-ripple2, .lz-blink { animation: none; } }
    </style>
  </defs>
  <rect width="240" height="240" rx="20" fill="url(#lz-bg)"/>
  <rect width="240" height="240" rx="20" fill="url(#lz-grid)"/>
  <path class="lz-route" d="M40 182 C 84 130, 120 196, 168 114" fill="none" stroke="#bae6fd" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="40" cy="182" r="5" fill="#ffffff"/>
  <circle class="lz-blink" cx="104" cy="166" r="5" fill="#38bdf8"/>
  <g transform="translate(168,114)" stroke="#ffffff" stroke-width="3" stroke-linejoin="round">
    <path d="M0 0 C -15 -20 -17 -30 -17 -34 a17 17 0 0 1 34 0 C 17 -30 15 -20 0 0 z" fill="rgba(255,255,255,0.18)"/>
    <circle cx="0" cy="-32" r="6.5" fill="#38bdf8" stroke="none"/>
  </g>
  <circle class="lz-ripple" cx="168" cy="116" r="14" fill="none" stroke="#38bdf8" stroke-width="2"/>
  <circle class="lz-ripple2" cx="168" cy="116" r="14" fill="none" stroke="#38bdf8" stroke-width="2"/>
  <g fill="#ffffff"><circle cx="200" cy="60" r="3"/><circle cx="58" cy="70" r="3"/></g>
</svg>`;
app.get('/tracking-animation.svg', (req, res) =>
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(TRACKING_SVG));

// Public "How it works" marketing page (features the tracking animation).
app.get('/how-it-works', (req, res) => res.type('html').send(HOWITWORKS_HTML));

// SEO: robots.txt — only the public marketing page + brand asset are
// crawlable; the password-gated dashboard at / (and /monitor) return 401
// to crawlers anyway, but disallow them explicitly for good measure.
app.get('/robots.txt', (req, res) =>
  res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send(
    `User-agent: *
Allow: /how-it-works$
Allow: /tracking-animation.svg
Disallow: /monitor
Disallow: /api/
Disallow: /

Sitemap: https://localizit.com/sitemap.xml
`));

// SEO: sitemap.xml — single public URL for now.
app.get('/sitemap.xml', (req, res) =>
  res.type('application/xml').set('Cache-Control', 'public, max-age=86400').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://localizit.com/how-it-works</loc>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`));

// Ensure the store is initialised before any request is handled. On serverless
// this runs once per warm instance; the promise is cached in store.js.
app.use(async (req, res, next) => {
  try { req.store = await getStore(); next(); }
  catch (e) { console.error('store init failed', e); res.status(500).json({ message: 'store unavailable' }); }
});

const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'demo-secret';

// Core ingest: store the ping, run the rules engine, persist any alerts.
async function ingestPing(store, p) {
  const deviceId = p.deviceId;
  if (!deviceId) return { skipped: true, reason: 'no deviceId' };

  if (!(await store.getAsset(deviceId))) {
    await store.createAsset({ device_id: deviceId, name: `Unregistered tag ${deviceId}` });
  }
  const lat = parseFloat(p.latitude), lng = parseFloat(p.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { skipped: true, reason: 'bad coords' };

  const prev = await store.lastLocation(deviceId);
  const stored = await store.insertLocation({
    device_id: deviceId, latitude: lat, longitude: lng,
    altitude: p.altitude ?? null, accuracy: p.accuracy ?? null, timestamp: p.timestamp ?? null,
  });
  const asset = await store.getAsset(deviceId);
  const fired = evaluate(asset, stored, prev);
  for (const a of fired) {
    await store.insertAlert({ device_id: deviceId, type: a.type, message: a.message, latitude: lat, longitude: lng });
  }
  return { deviceId, alerts: fired.length };
}

// ---- Webhook (vendor format, WebHook Push doc v1.1) ----------------------
// The token may be supplied three ways so any vendor system can authenticate:
//   - header  x-webhook-token: <token>
//   - URL path /api/webhook/<token>   (easiest — just one callback URL, no headers)
//   - query   /api/webhook?token=<token>
app.post(['/api/webhook', '/api/webhook/:token'], async (req, res) => {
  const token = req.params.token || req.query.token || req.get('x-webhook-token');
  if (token !== WEBHOOK_TOKEN) return res.status(401).json({ code: 401, message: 'bad token' });
  const data = Array.isArray(req.body?.data) ? req.body.data : [];
  if (data.length > 200) return res.status(413).json({ code: 413, message: 'batch too large' });
  let ingested = 0;
  for (const p of data) { await ingestPing(req.store, p); ingested++; }
  res.json({ code: 200, message: 'success', ingested });
});

// Friendly GET on the webhook URL so a browser visit confirms it's live
// (webhooks are POST-only; a plain browser GET would otherwise 404).
app.get(['/api/webhook', '/api/webhook/:token'], (req, res) => {
  const token = req.params.token || req.query.token || req.get('x-webhook-token');
  if (token !== WEBHOOK_TOKEN) {
    return res.status(401).json({ ok: false, message: 'ToolTrace webhook is live, but this token is missing or invalid. Send location data as an HTTP POST to this URL.' });
  }
  res.json({
    ok: true,
    message: 'ToolTrace webhook is live and ready. Send location data as an HTTP POST (JSON) to this same URL.',
    method: 'POST',
    contentType: 'application/json',
    bodyExample: { code: 200, message: 'success', data: [{ deviceId: 'unique-id', latitude: '22.5431', longitude: '114.0579', altitude: '10', timestamp: '2026-06-02T09:00:00Z', accuracy: '15', datePublished: '2026-06-02T09:00:05Z' }] },
  });
});

// ---- Read APIs -----------------------------------------------------------
app.get('/api/assets', async (req, res) => res.json(await req.store.listAssets()));
app.get('/api/assets/:id/track', async (req, res) => res.json(await req.store.track(req.params.id)));
app.get('/api/alerts', async (req, res) => res.json(await req.store.recentAlerts()));

// ---- Create / import / update / delete -----------------------------------
app.post('/api/assets', async (req, res) => {
  const b = req.body || {};
  const deviceId = (b.device_id || '').trim();
  if (!deviceId) return res.status(400).json({ message: 'device_id is required' });
  if (await req.store.getAsset(deviceId)) return res.status(409).json({ message: 'a tag with that ID already exists' });
  const created = await req.store.createAsset({
    device_id: deviceId, name: (b.name || '').trim() || `Tag ${deviceId}`,
    site: (b.site || '').trim() || null,
    fence_lat: b.fence_lat ?? null, fence_lng: b.fence_lng ?? null, fence_radius_m: b.fence_radius_m ?? null,
  });
  res.status(201).json(created);
});

app.post('/api/assets/import', async (req, res) => {
  const csv = String(req.body?.csv || '').trim();
  if (!csv) return res.status(400).json({ message: 'csv text is required' });
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /device|tag|id/i.test(lines[0].split(',')[0]) && lines[0].split(',').length > 1) lines.shift();

  const results = { added: 0, skipped: 0, errors: [] };
  for (const line of lines) {
    const [id, name, site, radius, flat, flng] = line.split(',').map((c) => (c ?? '').trim());
    const deviceId = (id || '').trim();
    if (!deviceId) { results.skipped++; continue; }
    if (await req.store.getAsset(deviceId)) { results.skipped++; results.errors.push(`${deviceId}: already exists`); continue; }
    const r = parseFloat(radius), la = parseFloat(flat), lo = parseFloat(flng);
    await req.store.createAsset({
      device_id: deviceId, name: name || `Tag ${deviceId}`, site: site || null,
      fence_lat: Number.isFinite(la) ? la : null, fence_lng: Number.isFinite(lo) ? lo : null,
      fence_radius_m: Number.isFinite(r) ? r : null,
    });
    results.added++;
  }
  res.status(201).json(results);
});

app.put('/api/assets/:id', async (req, res) => {
  const updated = await req.store.updateAsset(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ message: 'not found' });
  res.json(updated);
});

app.delete('/api/assets/:id', async (req, res) => {
  if (!(await req.store.getAsset(req.params.id))) return res.status(404).json({ message: 'not found' });
  await req.store.deleteAsset(req.params.id);
  res.json({ deleted: req.params.id });
});

// ---- Simulator (demo data without hardware) ------------------------------
app.post('/api/simulate', async (req, res) => {
  const { deviceId = 'DEMO-TAG-001', step = 'drift' } = req.body || {};
  const asset = await req.store.getAsset(deviceId);
  if (!asset) return res.status(404).json({ message: 'unknown device' });
  const last = await req.store.lastLocation(deviceId);

  let lat = last?.latitude ?? asset.fence_lat ?? -36.8485;
  let lng = last?.longitude ?? asset.fence_lng ?? 174.7633;
  const dLat = (m) => m / 111111;
  const dLng = (m) => m / (111111 * Math.cos((lat * Math.PI) / 180));

  if (step === 'jitter') { lat += dLat(8); lng += dLng(8); }
  else if (step === 'drift') { lat += dLat(120); lng += dLng(40); }
  else if (step === 'escape') {
    const r = (asset.fence_radius_m ?? 300) + 500;
    lat = (asset.fence_lat ?? lat) + dLat(r); lng = (asset.fence_lng ?? lng) + dLng(r);
  } else if (step === 'silent') {
    if (last) {
      const twoHrsAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
      await req.store.setLocationReceivedAt(last.id, twoHrsAgo);
    }
    lat += dLat(60); lng += dLng(60);
  }
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const result = await ingestPing(req.store, {
    deviceId, latitude: String(lat), longitude: String(lng), altitude: '12',
    accuracy: step === 'jitter' ? '8' : '25', timestamp: now, datePublished: now,
  });
  res.json(result);
});

// ---- Factory test monitor (read-only, token-gated, no dashboard login) ----
// Share /monitor/<WEBHOOK_TOKEN> with the factory so they can watch their test
// pings arrive live without needing the dashboard password.
app.get('/monitor/:token?', (req, res) => res.type('html').send(MONITOR_HTML));
app.get('/api/monitor/data', async (req, res) => {
  if ((req.query.token || '') !== WEBHOOK_TOKEN) return res.status(401).json({ message: 'bad token' });
  const pings = await req.store.recentPings(50);
  res.json({ storage: req.store.kind, count: pings.length, pings });
});

// Health/diagnostics — also reveals which storage backend is live.
app.get('/api/health', async (req, res) => res.json({ ok: true, storage: req.store.kind }));
