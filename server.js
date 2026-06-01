import express from 'express';
import { db } from './db.js';
import { evaluate, distanceMeters } from './rules.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------------
// Webhook ingest — matches the vendor's exact format (WebHook Push doc v1.1):
//   { code, message, data: [ { deviceId, latitude, longitude, altitude,
//                              timestamp, accuracy, datePublished } ] }
// The vendor batches at <=200 items per push. We accept the batch, store each
// ping, run the rules engine, and raise alerts.
//
// SECURITY NOTE: the vendor spec is plain HTTP with no auth. In production you
// must require HTTPS + a shared-secret header. We enforce a simple token here
// so the pattern is in place from day one.
// ---------------------------------------------------------------------------
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'demo-secret';

function ingestPing(p) {
  const deviceId = p.deviceId;
  if (!deviceId) return { skipped: true, reason: 'no deviceId' };

  // Auto-register unknown tags so nothing is silently dropped.
  const exists = db.prepare('SELECT device_id FROM assets WHERE device_id = ?').get(deviceId);
  if (!exists) {
    db.prepare('INSERT INTO assets (device_id, name) VALUES (?, ?)')
      .run(deviceId, `Unregistered tag ${deviceId}`);
  }

  const lat = parseFloat(p.latitude);
  const lng = parseFloat(p.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { skipped: true, reason: 'bad coords' };
  }

  const prev = db.prepare(
    'SELECT * FROM locations WHERE device_id = ? ORDER BY id DESC LIMIT 1'
  ).get(deviceId);

  const info = db.prepare(`
    INSERT INTO locations (device_id, latitude, longitude, altitude, accuracy, timestamp)
    VALUES (?,?,?,?,?,?)
  `).run(deviceId, lat, lng, p.altitude ?? null, p.accuracy ?? null, p.timestamp ?? null);

  const stored = db.prepare('SELECT * FROM locations WHERE id = ?').get(info.lastInsertRowid);
  const asset = db.prepare('SELECT * FROM assets WHERE device_id = ?').get(deviceId);

  const fired = evaluate(asset, stored, prev);
  const insAlert = db.prepare(`
    INSERT INTO alerts (device_id, type, message, latitude, longitude) VALUES (?,?,?,?,?)
  `);
  for (const a of fired) insAlert.run(deviceId, a.type, a.message, lat, lng);

  return { deviceId, alerts: fired.length };
}

app.post('/api/webhook', (req, res) => {
  const token = req.get('x-webhook-token');
  if (token !== WEBHOOK_TOKEN) return res.status(401).json({ code: 401, message: 'bad token' });

  const data = Array.isArray(req.body?.data) ? req.body.data : [];
  if (data.length > 200) return res.status(413).json({ code: 413, message: 'batch too large' });

  const results = data.map(ingestPing);
  res.json({ code: 200, message: 'success', ingested: results.length });
});

// ---------------------------------------------------------------------------
// Dashboard read APIs
// ---------------------------------------------------------------------------
app.get('/api/assets', (req, res) => {
  const assets = db.prepare('SELECT * FROM assets ORDER BY created_at').all().map((a) => {
    const last = db.prepare(
      'SELECT * FROM locations WHERE device_id = ? ORDER BY id DESC LIMIT 1'
    ).get(a.device_id);
    return { ...a, last };
  });
  res.json(assets);
});

app.get('/api/assets/:id/track', (req, res) => {
  const rows = db.prepare(
    'SELECT latitude, longitude, timestamp, received_at FROM locations WHERE device_id = ? ORDER BY id DESC LIMIT 200'
  ).all(req.params.id);
  res.json(rows.reverse());
});

app.get('/api/alerts', (req, res) => {
  res.json(db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 50').all());
});

// Register a new tag up front (before it has ever pinged). deviceId is the ID
// printed on the SpaceTag. Geofence is optional — set it now or later.
app.post('/api/assets', (req, res) => {
  const b = req.body || {};
  const deviceId = (b.device_id || '').trim();
  if (!deviceId) return res.status(400).json({ message: 'device_id is required' });
  const exists = db.prepare('SELECT device_id FROM assets WHERE device_id = ?').get(deviceId);
  if (exists) return res.status(409).json({ message: 'a tag with that ID already exists' });

  db.prepare(`INSERT INTO assets (device_id, name, site, fence_lat, fence_lng, fence_radius_m)
              VALUES (?,?,?,?,?,?)`).run(
    deviceId,
    (b.name || '').trim() || `Tag ${deviceId}`,
    (b.site || '').trim() || null,
    b.fence_lat ?? null, b.fence_lng ?? null, b.fence_radius_m ?? null
  );
  res.status(201).json(db.prepare('SELECT * FROM assets WHERE device_id = ?').get(deviceId));
});

// Bulk import — onboard a whole crate of tags at once from CSV text.
// Header row optional. Columns: device_id, name, site, fence_radius_m
// (fence centre, if a radius is given, defaults to the dashboard's choice via
// fence_lat/fence_lng if supplied per-row; otherwise radius is ignored).
app.post('/api/assets/import', (req, res) => {
  const csv = String(req.body?.csv || '').trim();
  if (!csv) return res.status(400).json({ message: 'csv text is required' });

  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Drop a header row if the first cell isn't a plausible device id.
  if (lines.length && /device|tag|id/i.test(lines[0].split(',')[0]) && lines[0].split(',').length > 1) {
    lines.shift();
  }

  const insert = db.prepare(`INSERT INTO assets (device_id, name, site, fence_lat, fence_lng, fence_radius_m)
                             VALUES (?,?,?,?,?,?)`);
  const results = { added: 0, skipped: 0, errors: [] };
  for (const line of lines) {
    const [id, name, site, radius, flat, flng] = line.split(',').map((c) => (c ?? '').trim());
    const deviceId = (id || '').trim();
    if (!deviceId) { results.skipped++; continue; }
    if (db.prepare('SELECT device_id FROM assets WHERE device_id = ?').get(deviceId)) {
      results.skipped++; results.errors.push(`${deviceId}: already exists`); continue;
    }
    const r = parseFloat(radius);
    const la = parseFloat(flat), lo = parseFloat(flng);
    insert.run(
      deviceId, name || `Tag ${deviceId}`, site || null,
      Number.isFinite(la) ? la : null,
      Number.isFinite(lo) ? lo : null,
      Number.isFinite(r) ? r : null
    );
    results.added++;
  }
  res.status(201).json(results);
});

// Delete a tag and all its data.
app.delete('/api/assets/:id', (req, res) => {
  const a = db.prepare('SELECT device_id FROM assets WHERE device_id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ message: 'not found' });
  db.prepare('DELETE FROM locations WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM alerts WHERE device_id = ?').run(req.params.id);
  db.prepare('DELETE FROM assets WHERE device_id = ?').run(req.params.id);
  res.json({ deleted: req.params.id });
});

// Update an asset (name/site, geofence, stolen mode).
app.put('/api/assets/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM assets WHERE device_id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ message: 'not found' });
  const b = req.body || {};
  db.prepare(`
    UPDATE assets SET name=?, site=?, stolen_mode=?, fence_lat=?, fence_lng=?, fence_radius_m=?
    WHERE device_id=?
  `).run(
    b.name ?? a.name, b.site ?? a.site, b.stolen_mode ?? a.stolen_mode,
    b.fence_lat ?? a.fence_lat, b.fence_lng ?? a.fence_lng, b.fence_radius_m ?? a.fence_radius_m,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM assets WHERE device_id = ?').get(req.params.id));
});

// ---------------------------------------------------------------------------
// Simulator — generates pings so you can watch alerts fire without hardware.
// step=jitter: tiny wobble (no alert). step=drift: moves ~120m (movement).
// step=escape: jumps outside the fence (geofence_exit). step=silent: backdates
// the previous ping to simulate a long quiet gap, then reports (reappeared).
// ---------------------------------------------------------------------------
app.post('/api/simulate', (req, res) => {
  const { deviceId = 'DEMO-TAG-001', step = 'drift' } = req.body || {};
  const asset = db.prepare('SELECT * FROM assets WHERE device_id = ?').get(deviceId);
  if (!asset) return res.status(404).json({ message: 'unknown device' });

  const last = db.prepare(
    'SELECT * FROM locations WHERE device_id = ? ORDER BY id DESC LIMIT 1'
  ).get(deviceId);

  // Base position: last known, else the fence centre, else Auckland CBD.
  let lat = last?.latitude ?? asset.fence_lat ?? -36.8485;
  let lng = last?.longitude ?? asset.fence_lng ?? 174.7633;

  const dLat = (m) => m / 111111;                                  // metres -> deg lat
  const dLng = (m) => m / (111111 * Math.cos((lat * Math.PI) / 180));

  if (step === 'jitter') { lat += dLat(8); lng += dLng(8); }
  else if (step === 'drift') { lat += dLat(120); lng += dLng(40); }
  else if (step === 'escape') {
    const c = { lat: asset.fence_lat ?? lat, lng: asset.fence_lng ?? lng };
    const r = (asset.fence_radius_m ?? 300) + 500;                 // well outside
    lat = c.lat + dLat(r); lng = c.lng + dLng(r);
  } else if (step === 'silent') {
    if (last) {
      // Backdate the previous report so the next one looks like a long gap.
      db.prepare("UPDATE locations SET received_at = datetime('now','-2 hours') WHERE id = ?")
        .run(last.id);
    }
    lat += dLat(60); lng += dLng(60);
  }

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const result = ingestPing({
    deviceId,
    latitude: String(lat),
    longitude: String(lng),
    altitude: '12',
    accuracy: step === 'jitter' ? '8' : '25',
    timestamp: now,
    datePublished: now,
  });
  res.json(result);
});

app.listen(PORT, () => console.log(`ToolTrace running on http://localhost:${PORT}`));
