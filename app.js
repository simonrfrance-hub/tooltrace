import express from 'express';
import { getStore } from './store.js';
import { evaluate } from './rules.js';
import { DASHBOARD_HTML } from './dashboard.js';

export const app = express();
app.use(express.json());

// Dashboard auth. Everything is gated behind a password EXCEPT:
//   - /api/webhook : the vendor can't log in; it authenticates with its token
//   - /api/health  : public liveness check
// If DASHBOARD_PASSWORD is unset (local dev), auth is disabled.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
app.use((req, res, next) => {
  if (req.path === '/api/webhook' || req.path === '/api/health') return next();
  if (!DASHBOARD_PASSWORD) return next();
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const pass = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    if (pass === DASHBOARD_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="ToolTrace"').status(401).send('Authentication required');
});

// Dashboard — served from the function (after auth), not as a CDN static file,
// so the password actually protects it.
app.get('/', (req, res) => res.type('html').send(DASHBOARD_HTML));

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
app.post('/api/webhook', async (req, res) => {
  if (req.get('x-webhook-token') !== WEBHOOK_TOKEN) return res.status(401).json({ code: 401, message: 'bad token' });
  const data = Array.isArray(req.body?.data) ? req.body.data : [];
  if (data.length > 200) return res.status(413).json({ code: 413, message: 'batch too large' });
  let ingested = 0;
  for (const p of data) { await ingestPing(req.store, p); ingested++; }
  res.json({ code: 200, message: 'success', ingested });
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

// Health/diagnostics — also reveals which storage backend is live.
app.get('/api/health', async (req, res) => res.json({ ok: true, storage: req.store.kind }));
