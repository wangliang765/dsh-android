'use strict';
/* M2 acceptance driver: drive the model through >=4 android_* tools and
 * verify structured results + clean error paths.
 * Phases:
 *   1. session warmup (bash) -> full catalog promotion
 *   2. android_device_info   -> structured facts
 *   3. android_notify        -> posted:true + id
 *   4. android_clipboard_write -> copied:true
 *   5. android_clipboard_read  -> round-trip equals written text
 *   6. android_share_text    -> shared:true (sheet opens on screen)
 *   7. bridge down path      -> BRIDGE_UNREACHABLE clean error (optional flag)
 */
const PORT = process.env.M1_PORT ?? '13081';
const BASE = `http://127.0.0.1:${PORT}/api`;

function rpc(method, payload) {
  return fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `m2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, method, payload }),
  }).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; });
}

async function tail(sid) { const h = await rpc('session.history', { sessionId: sid, maxMessages: 50 }); return h.json?.result?.value?.events ?? []; }

async function turn(sid, text) {
  const before = await tail(sid);
  const baseSeq = before.length > 0 ? Math.max(...before.map((row) => row.event?.seq ?? 0)) : -1;
  const sent = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text }] });
  if (!sent.json?.result?.value?.accepted) throw new Error(`prompt rejected: ${sent.text.slice(0, 200)}`);
  let events = before;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    events = await tail(sid);
    if (events.some((row) => row.event?.type === 'turn/end' && (row.event?.seq ?? 0) > baseSeq)) break;
  }
  const toolsUsed = [...new Set(events.filter((row) => row.event?.type === 'tool/call' && (row.event?.seq ?? 0) > baseSeq).map((row) => row.event.data.name))];
  const results = events.filter((row) => row.event?.type === 'tool/result' && (row.event?.seq ?? 0) > baseSeq);
  const end = events.find((row) => row.event?.type === 'turn/end' && (row.event?.seq ?? 0) > baseSeq);
  const msgs = events.filter((row) => row.event?.type === 'assistant/message');
  const last = msgs[msgs.length - 1];
  return {
    toolsUsed,
    results: results.map((row) => JSON.stringify(row.event?.data?.message?.content ?? [])),
    completed: end?.event?.data?.reason?.kind === 'completed',
    endReason: end?.event?.data?.reason,
    answer: (last?.event?.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' '),
  };
}

const created = await rpc('session.create', {});
const sid = created.json?.result?.value?.sessionId;
console.log('[session]', sid);

// Phase 1: promotion
const warm = await turn(sid, 'Call bash with command: echo M2-WARMUP && date');
console.log('[warmup] tools=', warm.toolsUsed, 'completed=', warm.completed);
if (!warm.toolsUsed.includes('bash')) { console.log('FAIL: warmup did not use bash'); process.exit(1); }

let score = 0;
const verdicts = [];

// Phase 2: device info
{
  const r = await turn(sid, 'Call android_device_info and report the manufacturer/model/battery line.');
  const ok = r.completed && r.results.some((s) => s.includes('"sdkInt"') || s.includes('manufacturer'));
  console.log(`[device_info] tools=${JSON.stringify(r.toolsUsed)} completed=${r.completed} answer=${r.answer.slice(0, 160)}`);
  verdicts.push(['android_device_info', ok]);
  if (ok) score++;
}

// Phase 3: notification
{
  const r = await turn(sid, 'Call android_notify with title "M2 验收" and text "bridge notification works". Report whether it posted.');
  const ok = r.completed && r.results.some((s) => s.includes('"posted":true') || s.includes('"posted" : true'));
  console.log(`[notify] tools=${JSON.stringify(r.toolsUsed)} completed=${r.completed} answer=${r.answer.slice(0, 160)}`);
  verdicts.push(['android_notify', ok]);
  if (ok) score++;
}

// Phase 4+5: clipboard round trip
{
  const marker = `DSH-M2-${Date.now()}`;
  const w = await turn(sid, `Call android_clipboard_write with text exactly "${marker}". Then reply OK.`);
  const wrote = w.completed && w.results.some((s) => s.includes('"copied":true'));
  console.log(`[clipboard_write] tools=${JSON.stringify(w.toolsUsed)} copied=${wrote}`);
  verdicts.push(['android_clipboard_write', wrote]);
  if (wrote) score++;
  const rd = await turn(sid, `Call android_clipboard_read and output the clipboard content verbatim.`);
  const got = rd.answer.includes(marker);
  console.log(`[clipboard_read] answer=${rd.answer.slice(0, 160)} roundtrip=${got}`);
  verdicts.push(['android_clipboard_read', got]);
  if (got) score++;
}

// Phase 6: share sheet (opens on screen; user may ignore it)
{
  const r = await turn(sid, 'Call android_share_text with text "Shared from DSH on Android". Reply with whether it reported success.');
  const ok = r.completed && r.results.some((s) => s.includes('"shared":true'));
  console.log(`[share] tools=${JSON.stringify(r.toolsUsed)} completed=${r.completed} answer=${r.answer.slice(0, 160)}`);
  verdicts.push(['android_share_text', ok]);
  if (ok) score++;
}

console.log('\n=== M2 ACCEPTANCE VERDICT ===');
for (const [name, ok] of verdicts) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`score: ${score}/5`);
process.exit(score >= 4 ? 0 : 2);
