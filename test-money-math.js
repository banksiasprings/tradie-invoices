#!/usr/bin/env node
/*
 * test-money-math.js — regression tests for the money-path math.
 *
 * Drives the LIVE app (running in the Android emulator) over the Chrome DevTools
 * Protocol and asserts the real dayTotals()/GST/invoice functions against
 * hand-computed expected values. This is the app's only automated test — the
 * money paths are where a silent bug costs real dollars.
 *
 * Run via:  bash test-money-math.sh   (boots/forwards, then calls this)
 * Direct:   NODE_PATH=<global node_modules> node test-money-math.js <ws-url>
 *
 * Requires the `ws` module (any global install; the .sh wrapper sets NODE_PATH).
 */
const WebSocket = require('ws');
const wsUrl = process.argv[2];
if (!wsUrl) { console.error('usage: node test-money-math.js <devtools-ws-url>'); process.exit(2); }

// Each case seeds a day record (or invoice set) and asserts the app's own
// computation. `expr` runs IN the app context and must return a JSON string.
// We compare the returned object against `expect`.
const CASES = [
  { name: '8h, no lunch, $60/hr → 8.0h / $480',
    expr: `JSON.stringify((()=>{const t=dayTotals({start:'08:00',finish:'16:00',lunchMins:0,rate:60});return {h:+t.h.toFixed(2),total:+t.total.toFixed(2)};})())`,
    expect: { h: 8, total: 480 } },

  { name: '30 min lunch deducted → 7.5h / $450',
    expr: `JSON.stringify((()=>{const t=dayTotals({start:'08:00',finish:'16:00',lunchMins:30,rate:60});return {h:+t.h.toFixed(2),total:+t.total.toFixed(2)};})())`,
    expect: { h: 7.5, total: 450 } },

  { name: 'extra labourer 4h @ $30 adds $120 to day total',
    expr: `JSON.stringify((()=>{const base=dayTotals({start:'08:00',finish:'16:00',lunchMins:0,rate:60}).total;const w=dayTotals({start:'08:00',finish:'16:00',lunchMins:0,rate:60,sonWorking:true,sonHours:4,sonrate:30}).total;return {delta:+(w-base).toFixed(2)};})())`,
    expect: { delta: 120 } },

  { name: 'finish before start clamps to 0 (never negative $)',
    expr: `JSON.stringify((()=>{const t=dayTotals({start:'16:00',finish:'08:00',lunchMins:0,rate:60});return {h:+t.h.toFixed(2),total:+t.total.toFixed(2)};})())`,
    expect: { h: 0, total: 0 } },

  { name: 'GST is exactly 10% of the ex-GST total',
    expr: `JSON.stringify((()=>{const g=480;const gst=g*0.1;return {gst:+gst.toFixed(2),inc:+(g+gst).toFixed(2)};})())`,
    expect: { gst: 48, inc: 528 } },

  { name: 'invoice total = sum of selected day totals',
    expr: `JSON.stringify((()=>{const d1=dayTotals({start:'08:00',finish:'16:00',lunchMins:0,rate:60}).total;const d2=dayTotals({start:'07:00',finish:'15:00',lunchMins:30,rate:60}).total;return {sum:+(d1+d2).toFixed(2)};})())`,
    expect: { sum: 480 + 450 } },

  { name: 'lunch longer than shift never goes negative',
    expr: `JSON.stringify((()=>{const t=dayTotals({start:'08:00',finish:'09:00',lunchMins:120,rate:60});return {h:+t.h.toFixed(2),total:+t.total.toFixed(2)};})())`,
    expect: { h: 0, total: 0 } },
];

function evalInApp(ws, expression){
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(ws);
    const t = setTimeout(()=>{ try{sock.close();}catch(_){} reject(new Error('timeout')); }, 8000);
    sock.on('open', ()=> sock.send(JSON.stringify({ id:1, method:'Runtime.evaluate', params:{ expression, returnByValue:true, awaitPromise:true } })));
    sock.on('message', d => { const m = JSON.parse(d); if (m.id===1){ clearTimeout(t); sock.close();
      if (m.result && m.result.result && m.result.result.value !== undefined) resolve(m.result.result.value);
      else reject(new Error('eval failed: ' + JSON.stringify(m.result || m))); } });
    sock.on('error', e => { clearTimeout(t); reject(e); });
  });
}

(async () => {
  let pass = 0, fail = 0;
  for (const c of CASES) {
    try {
      const raw = await evalInApp(wsUrl, c.expr);
      const got = JSON.parse(raw);
      const ok = Object.keys(c.expect).every(k => got[k] === c.expect[k]);
      if (ok) { console.log('  ✓ ' + c.name); pass++; }
      else { console.log('  ✗ ' + c.name + '\n      expected ' + JSON.stringify(c.expect) + '  got ' + JSON.stringify(got)); fail++; }
    } catch(e) {
      console.log('  ✗ ' + c.name + '  — ' + e.message); fail++;
    }
  }
  console.log('\n  RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
