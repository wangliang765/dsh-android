'use strict';
/* read_image end-to-end: warm up session (promotion), then request image analysis. */
const PORT = process.env.M1_PORT ?? '13081';
const BASE = `http://127.0.0.1:${PORT}/api`;
function rpc(method, payload) {
  return fetch(`${BASE}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, method, payload }) }).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; });
}
async function tail(sid) { const h = await rpc('session.history', { sessionId: sid, maxMessages: 50 }); return h.json?.result?.value?.events ?? []; }
const created = await rpc('session.create', {});
const sid = created.json?.result?.value?.sessionId;
console.log('[session]', sid);
await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'Call bash with command: echo WARM' }] });
let baseSeq = -1;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const ev = await tail(sid);
  const ends = ev.filter((row) => row.event?.type === 'turn/end');
  if (ends.length > 0) { baseSeq = Math.max(...ev.map((row) => row.event?.seq ?? 0)); break; }
}
console.log('[warmup done] seq=' + baseSeq);
await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'Use the read_image tool on file dsh-m1-test.jpg in the current workspace. Describe exactly what you see: background color, shapes, and any text.' }] });
for (let i = 0; i < 80; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const ev = await tail(sid);
  const end = ev.find((row) => row.event?.type === 'turn/end' && (row.event?.seq ?? 0) > baseSeq);
  if (!end) continue;
  const toolsUsed = [...new Set(ev.filter((row) => row.event?.type === 'tool/call' && (row.event?.seq ?? 0) > baseSeq).map((row) => row.event.data.name))];
  console.log('[tools used]', JSON.stringify(toolsUsed));
  const results = ev.filter((row) => row.event?.type === 'tool/result' && (row.event?.seq ?? 0) > baseSeq);
  for (const res of results) {
    const txt = JSON.stringify(res.event?.data?.message?.content ?? '').slice(0, 300);
    console.log('[tool result]', txt);
  }
  const msgs = ev.filter((row) => row.event?.type === 'assistant/message');
  const last = msgs[msgs.length - 1];
  console.log('[answer]', (last?.event?.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').slice(0, 700));
  const endData = end.event?.data ?? {};
  if (endData.reason?.kind !== 'completed') console.log('[turn end reason]', JSON.stringify(endData.reason));
  break;
}
