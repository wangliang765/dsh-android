'use strict';
/* Tier-1 acceptance: drive the model through the new zero-permission tools. */
const PORT = process.env.M1_PORT ?? '13080';
const BASE = `http://127.0.0.1:${PORT}/api`;
function rpc(method, payload) {
  return fetch(`${BASE}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `t1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, method, payload }) }).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; });
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
  return {
    toolsUsed: [...new Set(events.filter((row) => row.event?.type === 'tool/call' && (row.event?.seq ?? 0) > baseSeq).map((row) => row.event.data.name))],
    results: events.filter((row) => row.event?.type === 'tool/result' && (row.event?.seq ?? 0) > baseSeq).map((row) => JSON.stringify(row.event?.data?.message?.content ?? [])),
    completed: events.some((row) => row.event?.type === 'turn/end' && row.event?.data?.reason?.kind === 'completed' && (row.event?.seq ?? 0) > baseSeq),
    answer: (() => { const m = events.filter((row) => row.event?.type === 'assistant/message'); const last = m[m.length - 1]; return (last?.event?.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' '); })(),
  };
}
const created = await rpc('session.create', {});
const sid = created.json?.result?.value?.sessionId;
console.log('[session]', sid);
const warm = await turn(sid, 'Call bash with command: echo TIER1-WARMUP');
console.log('[warmup]', warm.toolsUsed, warm.completed);

let score = 0; const verdicts = [];
function judge(name, ok, detail) { verdicts.push([name, ok]); if (ok) score++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }

// 1+2: list apps then launch one
{
  const r = await turn(sid, 'Call android_list_apps and tell me how many apps there are and whether WeChat (com.tencent.mm) is among them.');
  const blob = r.results.join(' ') + ' ' + r.answer;
  const ok = r.completed && /com\.tencent\.mm|微信/i.test(blob);
  judge('android_list_apps', ok, r.answer.slice(0, 120));
  const l = await turn(sid, `Call android_launch_app with packageName "com.android.settings". Report whether it launched.`);
  const lblob = l.results.join(' ') + ' ' + l.answer;
  const lok = l.completed && /launch|启动|opened/i.test(lblob) && !lblob.includes('APP_NOT_FOUND');
  judge('android_launch_app', lok, l.answer.slice(0, 120));
}

// 3: volume get + set round trip
{
  const g = await turn(sid, 'Call android_volume_get and report the level.');
  const gb = g.results.join(' ') + ' ' + g.answer;
  const gok = g.completed && /\d+\/\d+|level/i.test(gb);
  judge('android_volume_get', gok, g.answer.slice(0, 120));
  const s = await turn(sid, 'Call android_volume_set with percent 60. Report the applied level.');
  const sb = s.results.join(' ') + ' ' + s.answer;
  const sok = s.completed && /volume|音量|\d+/i.test(sb) && !sb.includes('INVALID_TOOL_OUTPUT');
  judge('android_volume_set', sok, s.answer.slice(0, 120));
}

// 4: vibrate
{
  const r = await turn(sid, 'Call android_vibrate with durationMs 500. Confirm it vibrated.');
  const b = r.results.join(' ') + ' ' + r.answer;
  const ok = r.completed && /vibrat/i.test(b);
  judge('android_vibrate', ok, r.answer.slice(0, 120));
}

// 5: torch toggle on+off
{
  const a = await turn(sid, 'Call android_torch with on true.');
  const ab = a.results.join(' ') + ' ' + a.answer;
  const aok = /torch.*on|ON/i.test(ab) || a.completed;
  console.log(`    [torch on] ${a.answer.slice(0, 100)}`);
  const off = await turn(sid, 'Call android_torch with on false.');
  const ob = off.results.join(' ') + ' ' + off.answer;
  const ook = /torch.*off|OFF/i.test(ob) || off.completed;
  judge('android_torch', aok && ook && !ab.includes('NO_TORCH'), `${a.answer.slice(0, 80)} → ${off.answer.slice(0, 80)}`);
}

// 6: brightness set + auto restore
{
  const r = await turn(sid, 'Call android_brightness_set with percent 70, then call it again with auto true. Confirm both worked.');
  const b = r.results.join(' ') + ' ' + r.answer;
  const ok = r.completed && !b.includes('INVALID_TOOL_OUTPUT') && /bright|亮度|adaptive|auto/i.test(b);
  judge('android_brightness_set', ok, r.answer.slice(0, 120));
}

// 7: open url
{
  const r = await turn(sid, 'Call android_open_url with url "https://example.com". Report whether it opened.');
  const b = r.results.join(' ') + ' ' + r.answer;
  const ok = r.completed && /open|打开/i.test(b) && !b.includes('BAD_URL');
  judge('android_open_url', ok, r.answer.slice(0, 120));
}

// 8: dialer
{
  const r = await turn(sid, 'Call android_dial with number "10086". Report whether the dialer opened with the number filled.');
  const b = r.results.join(' ') + ' ' + r.answer;
  const ok = r.completed && /dial|10086/i.test(b);
  judge('android_dial', ok, r.answer.slice(0, 120));
}

// 9: timer
{
  const r = await turn(sid, 'Call android_set_alarm with seconds 90 and label "DSH验收". Confirm scheduled.');
  const b = r.results.join(' ') + ' ' + r.answer;
  const ok = r.completed && /timer|scheduled|倒计时|计时/i.test(b);
  judge('android_set_alarm', ok, r.answer.slice(0, 120));
}

console.log('\n=== TIER-1 ACCEPTANCE VERDICT ===');
for (const [name, ok] of verdicts) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`score: ${score}/${verdicts.length}`);
process.exit(score >= 7 ? 0 : 2);
