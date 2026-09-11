'use strict';
/* End-to-end: drive the MODEL to call android_list_apps over DSH web RPC,
 * then cross-check against the bridge directly. Usage: node drive-applist.mjs */
import { execSync } from 'node:child_process';

const PORT = process.env.M1_PORT ?? '13080';
const BRIDGE = process.env.M1_BRIDGE ?? 'http://127.0.0.1:13081';
const rpc = (method, payload) =>
  fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `al-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, method, payload }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

async function tail(sid) {
  const h = await rpc('session.history', { sessionId: sid, maxMessages: 60 });
  return h.json?.result?.value?.events ?? [];
}
async function turn(sid, text) {
  const before = await tail(sid);
  const baseSeq = before.length ? Math.max(...before.map((r) => r.event?.seq ?? 0)) : -1;
  const sent = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text }] });
  if (!sent.json?.result?.value?.accepted) throw new Error('prompt rejected');
  let events = before;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    events = await tail(sid);
    if (events.some((r) => r.event?.type === 'turn/end' && (r.event?.seq ?? 0) > baseSeq)) break;
  }
  return {
    toolsUsed: [...new Set(events.filter((r) => r.event?.type === 'tool/call' && (r.event?.seq ?? 0) > baseSeq).map((r) => r.event.data.name))],
    results: events.filter((r) => r.event?.type === 'tool/result' && (r.event?.seq ?? 0) > baseSeq).map((r) => JSON.stringify(r.event?.data?.message?.content ?? [])),
    completed: events.some((r) => r.event?.type === 'turn/end' && r.event?.data?.reason?.kind === 'completed' && (r.event?.seq ?? 0) > baseSeq),
    answer: (() => { const m = events.filter((r) => r.event?.type === 'assistant/message'); const last = m[m.length - 1]; return (last?.event?.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' '); })(),
  };
}

// Ground truth straight from the bridge:
const bl = await fetch(`${BRIDGE}/app/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
console.log(`[bridge ground truth] count=${bl.count} restricted=${bl.visibilityRestricted ?? false} hint=${bl.restrictionHint ?? '-'}`);

const created = await rpc('session.create', {});
const sid = created.json?.result?.value?.sessionId;
console.log('[session]', sid);

const warm = await turn(sid, 'Call bash with command: echo APPWARMUP');
console.log('[warmup]', warm.toolsUsed, warm.completed);

const r = await turn(sid, 'Call android_list_apps, then tell me how many apps are visible and whether WeChat (com.tencent.mm) and Settings (com.android.settings) are among them.');
console.log('[tools used]', r.toolsUsed.join(','));
console.log('[answer]', r.answer.slice(0, 300));
const blob = r.results.join(' ') + ' ' + r.answer;
const usedTool = r.toolsUsed.includes('android_list_apps');
const sawCount = /\d{2,}/.test(blob);
const sawWechat = /com\.tencent\.mm|微信/i.test(blob);
const noInvalid = !blob.includes('INVALID_TOOL_OUTPUT');
console.log(`${usedTool && sawCount && sawWechat && noInvalid && r.completed ? 'PASS' : 'FAIL'}  model-driven android_list_apps (tool=${usedTool} count=${sawCount} wechat=${sawWechat} clean=${noInvalid} done=${r.completed})`);
process.exit(usedTool && sawCount && sawWechat && noInvalid && r.completed ? 0 : 2);
