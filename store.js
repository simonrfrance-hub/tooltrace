// Storage abstraction with two backends behind one async interface:
//   - Postgres (Neon) when DATABASE_URL is set  -> persistent, for production
//   - in-memory otherwise                        -> so the app runs anywhere,
//                                                    incl. a fresh Vercel deploy
// The rest of the app only ever calls store.<method>(), never SQL directly.

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------
function memoryStore() {
  const assets = new Map();           // device_id -> asset
  let locations = [];                 // {id, device_id, ...}
  let alerts = [];                    // {id, ...}
  let locSeq = 0, alertSeq = 0;
  const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  function seed() {
    if (assets.size) return;
    assets.set('DEMO-TAG-001', {
      device_id: 'DEMO-TAG-001', name: 'Makita Drill (demo)', site: 'Greenfield Site',
      stolen_mode: 0, fence_lat: -36.8485, fence_lng: 174.7633, fence_radius_m: 300,
      created_at: nowIso(),
    });
  }

  return {
    kind: 'memory',
    async init() { seed(); },
    async listAssets() {
      return [...assets.values()]
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .map((a) => ({ ...a, last: this._lastSync(a.device_id) }));
    },
    _lastSync(id) {
      const rows = locations.filter((l) => l.device_id === id);
      return rows.length ? rows[rows.length - 1] : null;
    },
    async getAsset(id) { return assets.get(id) || null; },
    async createAsset(a) {
      assets.set(a.device_id, {
        device_id: a.device_id, name: a.name, site: a.site ?? null, stolen_mode: 0,
        fence_lat: a.fence_lat ?? null, fence_lng: a.fence_lng ?? null,
        fence_radius_m: a.fence_radius_m ?? null, created_at: nowIso(),
      });
      return assets.get(a.device_id);
    },
    async updateAsset(id, f) {
      const a = assets.get(id); if (!a) return null;
      Object.assign(a, {
        name: f.name ?? a.name, site: f.site ?? a.site, stolen_mode: f.stolen_mode ?? a.stolen_mode,
        fence_lat: f.fence_lat ?? a.fence_lat, fence_lng: f.fence_lng ?? a.fence_lng,
        fence_radius_m: f.fence_radius_m ?? a.fence_radius_m,
      });
      return a;
    },
    async deleteAsset(id) {
      assets.delete(id);
      locations = locations.filter((l) => l.device_id !== id);
      alerts = alerts.filter((al) => al.device_id !== id);
    },
    async lastLocation(id) { return this._lastSync(id); },
    async insertLocation(l) {
      const row = { id: ++locSeq, ...l, received_at: nowIso() };
      locations.push(row);
      return row;
    },
    async setLocationReceivedAt(id, iso) {
      const r = locations.find((l) => l.id === id); if (r) r.received_at = iso;
    },
    async track(id) {
      return locations.filter((l) => l.device_id === id).slice(-200)
        .map(({ latitude, longitude, timestamp, received_at }) => ({ latitude, longitude, timestamp, received_at }));
    },
    async insertAlert(a) { alerts.push({ id: ++alertSeq, ...a, created_at: nowIso() }); },
    async recentAlerts() { return [...alerts].reverse().slice(0, 50); },
    async recentPings(limit = 50) {
      return locations.slice(-limit).reverse()
        .map((l) => ({ device_id: l.device_id, name: assets.get(l.device_id)?.name ?? null,
          latitude: l.latitude, longitude: l.longitude, timestamp: l.timestamp, received_at: l.received_at }));
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres (Neon) implementation
// ---------------------------------------------------------------------------
async function pgStore() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Neon requires SSL
    max: 3,
  });
  const q = (text, params) => pool.query(text, params);
  const iso = (v) => (v == null ? null : new Date(v).toISOString().replace(/\.\d+Z$/, 'Z'));

  return {
    kind: 'postgres',
    async init() {
      await q(`
        CREATE TABLE IF NOT EXISTS assets (
          device_id TEXT PRIMARY KEY, name TEXT NOT NULL, site TEXT,
          stolen_mode INT DEFAULT 0,
          fence_lat DOUBLE PRECISION, fence_lng DOUBLE PRECISION, fence_radius_m DOUBLE PRECISION,
          created_at TIMESTAMPTZ DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS locations (
          id BIGSERIAL PRIMARY KEY, device_id TEXT NOT NULL,
          latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL,
          altitude TEXT, accuracy TEXT, timestamp TEXT, received_at TIMESTAMPTZ DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_loc_device ON locations(device_id, id);
        CREATE TABLE IF NOT EXISTS alerts (
          id BIGSERIAL PRIMARY KEY, device_id TEXT NOT NULL, type TEXT NOT NULL,
          message TEXT NOT NULL, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
          created_at TIMESTAMPTZ DEFAULT now()
        );`);
      const { rows } = await q('SELECT COUNT(*)::int AS n FROM assets');
      if (rows[0].n === 0) {
        await q(`INSERT INTO assets (device_id,name,site,fence_lat,fence_lng,fence_radius_m)
                 VALUES ('DEMO-TAG-001','Makita Drill (demo)','Greenfield Site',-36.8485,174.7633,300)`);
      }
    },
    async listAssets() {
      const { rows } = await q('SELECT * FROM assets ORDER BY created_at');
      for (const a of rows) {
        const l = await this.lastLocation(a.device_id);
        a.last = l;
      }
      return rows;
    },
    async getAsset(id) {
      const { rows } = await q('SELECT * FROM assets WHERE device_id=$1', [id]); return rows[0] || null;
    },
    async createAsset(a) {
      const { rows } = await q(
        `INSERT INTO assets (device_id,name,site,fence_lat,fence_lng,fence_radius_m)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [a.device_id, a.name, a.site ?? null, a.fence_lat ?? null, a.fence_lng ?? null, a.fence_radius_m ?? null]);
      return rows[0];
    },
    async updateAsset(id, f) {
      const a = await this.getAsset(id); if (!a) return null;
      const { rows } = await q(
        `UPDATE assets SET name=$1,site=$2,stolen_mode=$3,fence_lat=$4,fence_lng=$5,fence_radius_m=$6
         WHERE device_id=$7 RETURNING *`,
        [f.name ?? a.name, f.site ?? a.site, f.stolen_mode ?? a.stolen_mode,
         f.fence_lat ?? a.fence_lat, f.fence_lng ?? a.fence_lng, f.fence_radius_m ?? a.fence_radius_m, id]);
      return rows[0];
    },
    async deleteAsset(id) {
      await q('DELETE FROM locations WHERE device_id=$1', [id]);
      await q('DELETE FROM alerts WHERE device_id=$1', [id]);
      await q('DELETE FROM assets WHERE device_id=$1', [id]);
    },
    async lastLocation(id) {
      const { rows } = await q('SELECT * FROM locations WHERE device_id=$1 ORDER BY id DESC LIMIT 1', [id]);
      if (!rows[0]) return null;
      return { ...rows[0], received_at: iso(rows[0].received_at) };
    },
    async insertLocation(l) {
      const { rows } = await q(
        `INSERT INTO locations (device_id,latitude,longitude,altitude,accuracy,timestamp)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [l.device_id, l.latitude, l.longitude, l.altitude ?? null, l.accuracy ?? null, l.timestamp ?? null]);
      return { ...rows[0], received_at: iso(rows[0].received_at) };
    },
    async setLocationReceivedAt(id, isoStr) {
      await q('UPDATE locations SET received_at=$1 WHERE id=$2', [isoStr, id]);
    },
    async track(id) {
      const { rows } = await q(
        'SELECT latitude,longitude,timestamp,received_at FROM locations WHERE device_id=$1 ORDER BY id DESC LIMIT 200', [id]);
      return rows.reverse().map((r) => ({ ...r, received_at: iso(r.received_at) }));
    },
    async insertAlert(a) {
      await q('INSERT INTO alerts (device_id,type,message,latitude,longitude) VALUES ($1,$2,$3,$4,$5)',
        [a.device_id, a.type, a.message, a.latitude ?? null, a.longitude ?? null]);
    },
    async recentAlerts() {
      const { rows } = await q('SELECT * FROM alerts ORDER BY id DESC LIMIT 50');
      return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
    },
    async recentPings(limit = 50) {
      const { rows } = await q(
        `SELECT l.device_id, a.name, l.latitude, l.longitude, l.timestamp, l.received_at
         FROM locations l LEFT JOIN assets a ON a.device_id = l.device_id
         ORDER BY l.id DESC LIMIT $1`, [limit]);
      return rows.map((r) => ({ ...r, received_at: iso(r.received_at) }));
    },
  };
}

let _store = null, _ready = null;
export async function getStore() {
  if (_store) return _store;
  if (!_ready) {
    _ready = (async () => {
      _store = DATABASE_URL ? await pgStore() : memoryStore();
      await _store.init();
      return _store;
    })();
  }
  return _ready;
}
