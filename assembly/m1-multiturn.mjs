'use strict';
/* Two prompts in ONE session: promote via bash, then dump tool list. */
const PORT = process.env.M1_PORT ?? '13081';
const BASE = `http://127.0.0.1:${PORT}/api`;
function rpc(method, payload) {
  return fetch(`${BASE}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `m2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, method, payload }) }).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; });
}
async function currentTail(sid) {
  const h = await rpc('session.history', { sessionId: sid, maxMessages: 50 });
  return h.json?.result?.value?.events ?? [];
}
async function settle(sid) {
  const base = await currentTail(sid);
  const baseSeq = base.length > 0 ? Math.max(...base.map((row) => row.event?.seq ?? 0)) : -1;
  let events = base;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    events = await currentTail(sid);
    const newEnds = events.filter((row) => row.event?.type === 'turn/end' && (row.event?.seq ?? 0) > baseSeq);
    if (newEnds.length > 0) return events;
  }
  return events;
}
function lastText(events) {
  const msgs = events.filter((row) => row.event?.type === 'assistant/message');
  const last = msgs[msgs.length - 1];
  if (!last) return '(none)';
  const content = last.event?.data?.message?.content ?? [];
  return content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
}
const created = await rpc('session.create', {});
const sid = created.json?.result?.value?.sessionId;
console.log('[session]', sid);
await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'Call bash with command: echo PROMOTE-NOW' }] });
let ev = await settle(sid);
console.log('[round1 done] turnEnds=', ev.filter((r) => r.event?.type === 'turn/end').length);
await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'Now output ONLY the comma-separated list of every tool name currently in your tools section.' }] });
ev = await settle(sid);
console.log('[round2 tool list]:', lastText(ev));
// round 3: web search now that promoted
await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: 'Use web_search to search "Android 16 KB page size", then reply with one line fact from results.' }] });
ev = await settle(sid);
const toolNames = ev.filter((r) => r.event?.type === 'tool/call').map((r) => r.event.data.name);
console.log('[round3 tools used]', JSON.stringify([...new Set(toolNames)]));
console.log('[round3 answer]:', lastText(ev).slice(0, 400));
