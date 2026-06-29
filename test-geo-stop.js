#!/usr/bin/env node
/*
 * test-geo-stop.js — regression tests for the v89 auto-STOP hardening.
 *
 * Drives the LIVE app (Android emulator) over the Chrome DevTools Protocol and
 * exercises _confirmDepartureThenStop() / recoverPendingStop() against the exact
 * field failure modes seen in the mirrored GeoLog at a real rural site:
 * fused-location fixes that PASS the accuracy gate yet are km off, and app-kill
 * recovery that blindly trusted a stale native EXIT. Coords below are synthetic.
 *
 * The golden rule under test: a timer stop is applied ONLY when a fresh,
 * accurate (<=100m) fix puts the phone genuinely OUTSIDE the site. A poor /
 * stale / unavailable / inside fix must NOT stop (a missed stop is one tap to
 * fix; a FALSE stop corrupts the whole workday).
 *
 * Run via: bash test-geo-stop.sh
 */
const WebSocket = require('ws');
const wsUrl = process.argv[2];
if (!wsUrl) { console.error('usage: node test-geo-stop.js <devtools-ws-url>'); process.exit(2); }

function evalInApp(expression){
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    const t = setTimeout(()=>{ try{sock.close();}catch(_){} reject(new Error('timeout')); }, 12000);
    sock.on('open', ()=> sock.send(JSON.stringify({ id:1, method:'Runtime.evaluate', params:{ expression, returnByValue:true, awaitPromise:true } })));
    sock.on('message', d => { const m = JSON.parse(d); if (m.id===1){ clearTimeout(t); sock.close();
      if (m.result && m.result.exceptionDetails) return reject(new Error('JS exception: ' + JSON.stringify(m.result.exceptionDetails).slice(0,300)));
      if (m.result && m.result.result && m.result.result.value !== undefined) resolve(m.result.result.value);
      else reject(new Error('eval failed: ' + JSON.stringify(m.result || m))); } });
    sock.on('error', e => { clearTimeout(t); reject(e); });
  });
}

// Synthetic test site + the large 2900m radius pattern from the field.
const SITE = `{name:'Test Site',lat:-27.00000,lng:153.00000,radius:2900}`;

// One-time setup: stub UI side-effects, install a controllable geolocation mock,
// seed the site list. window.__mockPos = {lat,lng,acc} or null (=unavailable).
const SETUP = `(()=>{
  window.showReview = function(){};            // isolate stop DECISION from review UI
  window.toast = function(){};
  window.__origGCP = window.__origGCP || navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
  navigator.geolocation.getCurrentPosition = function(ok,err,opts){
    if(window.__mockPos===null){ if(err) err({code:2,message:'mock unavailable'}); return; }
    ok({coords:{latitude:window.__mockPos.lat,longitude:window.__mockPos.lng,accuracy:window.__mockPos.acc},timestamp:Date.now()});
  };
  DB.set('sites', [${SITE}]);
  return 'setup-ok:'+(typeof window._confirmDepartureThenStop)+'/'+(typeof window.recoverPendingStop)+'/sites='+sites().length;
})()`;

// Reset to a fresh RUNNING day before each case.
const RESET = `(()=>{ DB.set('activeDay',{id:'t'+Date.now(),site:'Test Site',start:'08:00',date:todayStr(),rate:60}); localStorage.removeItem('mcn_pendingStop'); try{geoAutoStopTriggered=false;geoAutoStopDate=null;}catch(_){} return 'reset'; })()`;

// Each case: set mock pos (+ optional pendingStop), run the action, let async
// callbacks flush, then report whether the day was stopped.
function caseExpr(body){
  return `(async()=>{ ${body}; await new Promise(r=>setTimeout(r,120));
    const ad=activeDay(); const ps=localStorage.getItem('mcn_pendingStop');
    return JSON.stringify({finish: ad&&ad.finish||null, pendingStop: ps?JSON.parse(ps):null}); })()`;
}

const CASES = [
  { name: 'FALSE exit (31km-glitch): fresh fix shows INSIDE → do NOT stop',
    body: `window.__mockPos={lat:-27.00000,lng:153.00000,acc:12};
           await window._confirmDepartureThenStop('Test Site','20:05','T1')`,
    expect: g => g.finish === null },

  { name: 'Exit but fresh fix INACCURATE (600m) → do NOT stop',
    body: `window.__mockPos={lat:-27.20000,lng:153.00000,acc:600};
           await window._confirmDepartureThenStop('Test Site','17:00','T2')`,
    expect: g => g.finish === null },

  { name: 'Exit but fresh GPS UNAVAILABLE → do NOT stop',
    body: `window.__mockPos=null;
           await window._confirmDepartureThenStop('Test Site','17:00','T3')`,
    expect: g => g.finish === null },

  { name: 'GENUINE departure: fresh accurate fix OUTSIDE → STOP at exit time',
    body: `window.__mockPos={lat:-27.20000,lng:153.00000,acc:12};
           await window._confirmDepartureThenStop('Test Site','17:00','T4')`,
    expect: g => g.finish === '17:00' },

  { name: 'recoverPendingStop (08:59 field bug): app-kill recovery, still ON SITE → do NOT stop, clear pending',
    body: `localStorage.setItem('mcn_pendingStop',JSON.stringify({site:'Test Site',exitTime:'08:59',fireAt:Date.now()-60000}));
           window.__mockPos={lat:-27.00000,lng:153.00000,acc:12};
           window.recoverPendingStop()`,
    expect: g => g.finish === null && g.pendingStop === null },

  { name: 'recoverPendingStop: genuinely LEFT (accurate, outside) → STOP at recorded exit time',
    body: `localStorage.setItem('mcn_pendingStop',JSON.stringify({site:'Test Site',exitTime:'17:05',fireAt:Date.now()-60000}));
           window.__mockPos={lat:-27.20000,lng:153.00000,acc:12};
           window.recoverPendingStop()`,
    expect: g => g.finish === '17:05' && g.pendingStop === null },
];

(async () => {
  let pass=0, fail=0;
  const s = await evalInApp(SETUP);
  console.log('  ' + s);
  if (!String(s).startsWith('setup-ok:function/function')) { console.error('✗ setup failed — geo helpers not exposed'); process.exit(1); }
  for (const c of CASES) {
    try {
      await evalInApp(RESET);
      const raw = await evalInApp(caseExpr(c.body));
      const got = JSON.parse(raw);
      const ok = c.expect(got);
      console.log((ok?'  ✓ ':'  ✗ ') + c.name);
      if (!ok) { console.log('      got: ' + JSON.stringify(got)); fail++; } else pass++;
    } catch(e) {
      console.log('  ✗ ' + c.name + '  — ' + e.message); fail++;
    }
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
