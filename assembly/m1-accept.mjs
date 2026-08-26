'use strict';
/* M1 acceptance driver (PC smoke): real-model chat + tool evidence via loopback RPC.
 * Usage: node m1-accept.mjs <modelId> [promptTextFile]
 * Requires smoke server running on 127.0.0.1:31560 with CLOUD_API_KEY env set.
 */
const PORT = process.env.M1_PORT ?? '31560';
const BASE = `http://127.0.0.1:${PORT}/api`;

function rpc(method, payload) {
  return fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `m1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, method, payload }),
  }).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  });
}

const modelId = process.argv[2] ?? 'qwen3.8-max';
const promptFile = process.argv[3];
let promptText = 'Model check. Reply in Chinese, one short line naming your model, then call the bash tool to run `pwd && uname -s` and report its result verbatim.';
if (promptFile) promptText = await (await import('node:fs/promises')).readFile(promptFile, 'utf8');

const created = await rpc('session.create', {});
console.log('[create]', created.status, JSON.stringify(created.json ?? created.text).slice(0, 600));
const sid = created.json?.result?.value?.sessionId ?? created.json?.payload?.sessionId ?? created.json?.sessionId;
if (!sid) {
  console.log('NO SESSION ID — dumping full envelope:');
  console.log((created.json ? JSON.stringify(created.json, null, 2) : created.text)?.slice(0, 4000));
  process.exit(2);
}
console.log('[session]', sid);

// Try to select model explicitly; tolerate rejection.
for (const attempt of [
  { method: 'session.set-model', payload: { sessionId: sid, model: modelId } },
]) {
  const r = await rpc(attempt.method, attempt.payload);
  console.log(`[${attempt.method}]`, r.status, JSON.stringify(r.json ?? r.text).slice(0, 300));
}

const prompted = await rpc('session.prompt', {
  sessionId: sid,
  mode: 'queue',
  content: [{ type: 'text', text: promptText }],
});
console.log('[prompt]', prompted.status, JSON.stringify(prompted.json ?? prompted.text).slice(0, 600));

// Poll history until the turn settles.
let lastLen = -1, stable = 0;
for (let i = 0; i < 90; i++) {
  await new Promise((res) => setTimeout(res, 3000));
  const h = await rpc('session.history', { sessionId: sid, maxMessages: 50 });
  const j = h.json;
  if (!j) { console.log('[history] non-json:', h.status, h.text.slice(0, 200)); continue; }
  const value = j.result?.value ?? {};
  const entries = value.events ?? [];
  const blob = JSON.stringify(entries);
  if (blob.length === lastLen) stable++; else { stable = 0; lastLen = blob.length; }
  if (i % 5 === 0) console.log(`[poll ${i}] entries=${entries.length} bytes=${blob.length} stable=${stable}`);
  if ((stable >= 2 && entries.length > 1) || (stable >= 6 && entries.length > 0)) {
    console.log('[history FINAL]', JSON.stringify({ hasMore: value.hasMore }));
    for (const row of entries) {
      const e = row.event ?? row;
      const t = e.type ?? '?';
      let detail = '';
      if (e.message) {
        const parts = Array.isArray(e.message.content) ? e.message.content : [e.message.content];
        detail = parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' | ');
      } else {
        detail = JSON.stringify(e).slice(0, 900);
      }
      console.log(`-- [${t}] ${String(detail).slice(0, 1600)}`);
    }
    process.exit(0);
  }
}
console.log('[TIMEOUT waiting turn completion]');
process.exit(3);
