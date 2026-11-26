// Sends one HMAC-signed POST to a Ripple web trigger and prints the response.
// usage: RIPPLE_SIGNING_KEY=id:secret node scripts/smoke.mjs <base-url> <path> <json-file | inline-json>
import { existsSync, readFileSync } from 'node:fs';
import { parseSigningKey, signRequest } from '../packages/contracts/dist/index.js';

const [baseUrl, path, payload] = process.argv.slice(2);
const key = parseSigningKey(process.env.RIPPLE_SIGNING_KEY);
if (!baseUrl || !path || !payload || key === null) {
  console.error('usage: RIPPLE_SIGNING_KEY=id:secret node scripts/smoke.mjs <base-url> <path> <json-file | inline-json>');
  process.exit(1);
}
const body = JSON.stringify(JSON.parse(existsSync(payload) ? readFileSync(payload, 'utf8') : payload));
const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...signRequest({ method: 'POST', path, body }, key) },
  body,
});
console.log(`POST ${path} -> HTTP ${response.status}`);
console.log(await response.text());
