// Bundles web/index.html into dashboard.js as an escaped JS string, so the
// serverless function can serve it without any runtime file-path concerns.
// Run via `npm run build` whenever web/index.html changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const html = readFileSync(fileURLToPath(new URL('web/index.html', root)), 'utf8');
const out = `// AUTO-GENERATED from web/index.html by scripts/gen-dashboard.js — do not edit.\nexport const DASHBOARD_HTML = ${JSON.stringify(html)};\n`;
writeFileSync(fileURLToPath(new URL('dashboard.js', root)), out);
console.log(`dashboard.js written (${html.length} bytes of HTML)`);
