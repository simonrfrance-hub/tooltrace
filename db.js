// SQLite store. One file, no external services — fine for a local prototype/demo.
// For production on Vercel/serverless, swap this for Neon/Postgres (same queries).
import Database from 'better-sqlite3';

export const db = new Database('tooltrace.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS assets (
    device_id     TEXT PRIMARY KEY,   -- the tag's deviceId from the vendor webhook
    name          TEXT NOT NULL,      -- "Makita drill", "Site van", etc.
    site          TEXT,               -- job site / owner grouping
    stolen_mode   INTEGER DEFAULT 0,  -- 1 = tighten thresholds + escalate
    -- geofence: a circle (centre + radius). Null = no fence set.
    fence_lat     REAL,
    fence_lng     REAL,
    fence_radius_m REAL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS locations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL,
    latitude    REAL NOT NULL,
    longitude   REAL NOT NULL,
    altitude    TEXT,
    accuracy    TEXT,
    timestamp   TEXT,                 -- vendor "data collection time" (UTC)
    received_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_loc_device ON locations(device_id, id);

  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT NOT NULL,
    type        TEXT NOT NULL,        -- geofence_exit | movement | reappeared
    message     TEXT NOT NULL,
    latitude    REAL,
    longitude   REAL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_alert_created ON alerts(id);
`);

// Seed a demo asset with a geofence so the dashboard isn't empty on first run.
const seeded = db.prepare('SELECT COUNT(*) AS n FROM assets').get();
if (seeded.n === 0) {
  db.prepare(`INSERT INTO assets (device_id, name, site, fence_lat, fence_lng, fence_radius_m)
              VALUES (?,?,?,?,?,?)`)
    .run('DEMO-TAG-001', 'Makita Drill (demo)', 'Greenfield Site', -36.8485, 174.7633, 300);
}
