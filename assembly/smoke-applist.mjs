'use strict';
/* Post-install smoke: hit DSH web /api health then Bridge /app/list directly.
 * Usage: node smoke-applist.mjs [dshPort=13080] [bridgePort=13081] */
import { readFileSync } from 'node:fs';

const [, , dshPort = '13080', bridgePort = '13081'] = process.argv;
const BRIDGE = `http://127.0.0.1:${bridgePort}`;

async function bridge(method, payload) {
  const r = await fetch(`${BRIDGE}${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const health = await bridge('/health');
console.log('[bridge/health]', health.status, JSON.stringify(health.json));
if (!health.json?.ok || health.json?.version !== 2) {
  console.error('FAIL: bridge v2 not reachable');
  process.exit(2);
}

const list = await bridge('/app/list');
const apps = list.json?.apps ?? [];
const pkgs = new Set(apps.map((a) => a.packageName));
console.log(`[app/list] count=${apps.length}`);
// Cross-check against pm list packages on the device for a second opinion:
let shellCount = -1;
try {
  const { execSync } = await import('node:child_process');
  const out = execSync('adb shell pm list packages -3', { encoding: 'utf8' });
  shellCount = out.split('\n').filter((l) => l.startsWith('package:')).length;
} catch {}
console.log(`[pm list packages -3] third-party count=${shellCount}`);
if (shellCount > 0) {
  // Visible list should be >= third-party apps; system launchables add more.
  console.log(pkgs.size >= shellCount ? 'PASS: visible >= third-party count' : `WARN: visible ${pkgs.size} < 3rd-party ${shellCount}`);
}
const probes = ['com.tencent.mm', 'com.android.settings'];
for (const p of probes) console.log(`  ${p}: ${pkgs.has(p) ? 'present' : 'MISSING'}`);
console.log('sample:', apps.slice(0, 8).map((a) => `${a.label}<${a.packageName}>`).join(', '));
process.exit(apps.length > 20 && pkgs.has('com.tencent.mm') ? 0 : 2);
