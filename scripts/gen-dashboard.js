// Bundles the web/*.html pages into dashboard.js as escaped JS strings, so the
// serverless function can serve them without any runtime file-path concerns.
// Run via `npm run build` whenever a page in web/ changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(fileURLToPath(new URL('web/' + f, root)), 'utf8');

const dashboard = read('index.html');
const monitor = read('monitor.html');
const out =
  `// AUTO-GENERATED from web/*.html by scripts/gen-dashboard.js — do not edit.\n` +
  `export const DASHBOARD_HTML = ${JSON.stringify(dashboard)};\n` +
  `export const MONITOR_HTML = ${JSON.stringify(monitor)};\n`;
writeFileSync(fileURLToPath(new URL('dashboard.js', root)), out);
console.log(`dashboard.js written (dashboard ${dashboard.length}B, monitor ${monitor.length}B)`);
