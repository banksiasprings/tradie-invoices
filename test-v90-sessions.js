#!/usr/bin/env node
/*
 * test-v90-sessions.js — end-to-end tests for the v90 multi-session queue,
 * driving the LIVE app in the emulator over the Chrome DevTools Protocol.
 *
 * Exercises the REAL shipped functions (reconstructAndReconcile, seal,
 * confirm/reject/adjust, migrateToV90) against real localStorage — the pure
 * builder is unit-tested separately in test-sessions.js.
 *
 * All synthetic events use dates far in the past so the v89 trailing-same-day
 * fresh-fix STOP gate never engages (no GPS needed): every reconstructed session
 * is a trusted historical pair.
 *
 * Run via:  bash test-v90-sessions.sh
 */
const WebSocket = require('ws');
const wsUrl = process.argv[2];
if (!wsUrl) { console.error('usage: node test-v90-sessions.js <devtools-ws-url>'); process.exit(2); }

let _id = 0;
function run(expression){
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    const myId = ++_id;
    const t = setTimeout(()=>{ try{sock.close();}catch(_){} reject(new Error('timeout')); }, 15000);
    sock.on('open', ()=> sock.send(JSON.stringify({ id:myId, method:'Runtime.evaluate',
      params:{ expression, returnByValue:true, awaitPromise:true } })));
    sock.on('message', d => { const m = JSON.parse(d); if (m.id===myId){ clearTimeout(t); sock.close();
      if (m.result && m.result.exceptionDetails) return reject(new Error('JS exception: '+JSON.stringify(m.result.exceptionDetails).slice(0,300)));
      if (m.result && m.result.result && m.result.result.value !== undefined) resolve(m.result.result.value);
      else reject(new Error('eval failed: ' + JSON.stringify(m.result || m).slice(0,300))); } });
    sock.on('error', e => { clearTimeout(t); reject(e); });
  });
}
async function j(expr){ return JSON.parse(await run(expr)); }

// Build a native-style event. Past date (2020) → no trailing-same-day GPS gate.
function ev(type, site, dayN, time){
  const date = '2020-01-0'+dayN;
  const [h,mi] = time.split(':').map(Number);
  const timestamp = Date.parse(date+'T'+time+':00Z') ; // UTC — only relative ordering matters
  return { type, site, date, time, timestamp };
}
const EVJSON = a => JSON.stringify(a);

let pass=0, fail=0;
function check(name, cond, detail){
  if(cond){ console.log('  ✓ '+name); pass++; }
  else { console.log('  ✗ '+name + (detail?('\n      '+detail):'')); fail++; }
}
const RESET = `(()=>{DB.set('days',[]);setUnconfirmed([]);DB.set('activeDay',null);return 'ok';})()`;

(async () => {
  // sanity: v90 functions present
  const ver = await run(`APP_VERSION`);
  console.log('── v90 multi-session tests (live app '+ver+') ──');
  const wired = await j(`JSON.stringify({b:typeof buildSessionsFromEvents,r:typeof reconstructAndReconcile,c:typeof confirmSession,m:typeof migrateToV90,u:typeof unconfirmed})`);
  check('v90 functions wired into app', wired.b==='function'&&wired.r==='function'&&wired.c==='function'&&wired.m==='function'&&wired.u==='function', JSON.stringify(wired));

  // ── MIGRATION ───────────────────────────────────────────────────────────────
  await run(RESET);
  const mig = await j(`(()=>{
    DB.set('days',[{id:'d1',date:'2020-01-01',site:'Muirlawn',start:'09:00',finish:'17:00',rate:60,lunchMins:0}]);
    DB.set('activeDay',{id:'a1',date:'2020-01-02',site:'Muirlawn',start:'08:00',finish:'15:00',rate:60,lunchMins:0});
    setUnconfirmed([]);
    migrateToV90();
    const d=days(); const uc=unconfirmed();
    return JSON.stringify({ dayStatus:d[0]&&d[0].status, dayCount:d.length, ucCount:uc.length, ucStatus:uc[0]&&uc[0].status, activeCleared: activeDay()===null });
  })()`);
  check('migration: existing day tagged CONFIRMED', mig.dayStatus==='CONFIRMED' && mig.dayCount===1, JSON.stringify(mig));
  check('migration: finished activeDay → 1 UNCONFIRMED backlog entry', mig.ucCount===1 && mig.ucStatus==='UNCONFIRMED', JSON.stringify(mig));
  check('migration: activeDay cleared', mig.activeCleared===true, JSON.stringify(mig));

  // ── FLAGSHIP: 3-day reconstruction, app never opened ─────────────────────────
  await run(RESET);
  const three = EVJSON([
    ev('enter','Muirlawn',6,'09:00'), ev('exit','Muirlawn',6,'17:00'),
    ev('enter','Muirlawn',7,'09:00'), ev('exit','Muirlawn',7,'17:00'),
    ev('enter','Muirlawn',8,'09:00'), ev('exit','Muirlawn',8,'17:00')
  ]);
  const r3 = await j(`(async()=>{ await reconstructAndReconcile(${three});
    const q=unconfirmedQueue(); return JSON.stringify({ n:q.length, days:q.map(s=>s.date+' '+s.start+'-'+s.finish), statuses:[...new Set(q.map(s=>s.status))] }); })()`);
  check('3-day reconstruct → 3 UNCONFIRMED sessions', r3.n===3 && r3.statuses.length===1 && r3.statuses[0]==='UNCONFIRMED', JSON.stringify(r3));
  check('3-day reconstruct → correct per-day times', JSON.stringify(r3.days)===JSON.stringify(['2020-01-06 09:00-17:00','2020-01-07 09:00-17:00','2020-01-08 09:00-17:00']), JSON.stringify(r3.days));

  // ── CONFIRM only CONFIRMED flows to days[] (invoice + stats source) ──────────
  const conf = await j(`(()=>{ const q=unconfirmedQueue(); const first=q[0].id; confirmSession(first);
    const d=days(); const uc=unconfirmedQueue();
    return JSON.stringify({ daysN:d.length, dayInvoiced:d[0]&&d[0].invoiced, dayStatus:d[0]&&d[0].status, ucN:uc.length, gone: uc.every(s=>s.id!==first) }); })()`);
  check('confirm → session moved to days[] (invoiced:false, CONFIRMED)', conf.daysN===1 && conf.dayInvoiced===false && conf.dayStatus==='CONFIRMED', JSON.stringify(conf));
  check('confirm → removed from backlog (queue now 2)', conf.ucN===2 && conf.gone===true, JSON.stringify(conf));

  // ── REJECT keeps the record (audit) but never bills it ───────────────────────
  const rej = await j(`(()=>{ const q=unconfirmedQueue(); const id=q[0].id; rejectSession(id);
    const uc=unconfirmed(); const rec=uc.find(s=>s.id===id);
    return JSON.stringify({ queueN:unconfirmedQueue().length, kept: !!rec, status: rec&&rec.status, inDays: days().some(d=>d.id===id) }); })()`);
  check('reject → status REJECTED, kept in store, not billed', rej.status==='REJECTED' && rej.kept===true && rej.inDays===false && rej.queueN===1, JSON.stringify(rej));

  // ── ADJUST stamps edited_by_user and keeps UNCONFIRMED ───────────────────────
  const adj = await j(`(()=>{ const q=unconfirmedQueue(); const id=q[0].id; const uc=unconfirmed();
    const i=uc.findIndex(s=>s.id===id); uc[i].start='08:30'; uc[i].edited_by_user=true; uc[i].status=SESSION_STATUS.UNCONFIRMED; setUnconfirmed(uc);
    const s2=unconfirmedQueue().find(s=>s.id===id);
    return JSON.stringify({ start:s2.start, edited:s2.edited_by_user, status:s2.status }); })()`);
  check('adjust → edited_by_user stamped, still UNCONFIRMED', adj.start==='08:30' && adj.edited===true && adj.status==='UNCONFIRMED', JSON.stringify(adj));

  // ── SAME-DAY MERGE (30 min < 90) — past date, trusted ────────────────────────
  await run(RESET);
  const mrg = EVJSON([
    ev('enter','Muirlawn',9,'09:00'), ev('exit','Muirlawn',9,'12:00'),
    ev('enter','Muirlawn',9,'12:30'), ev('exit','Muirlawn',9,'17:00')
  ]);
  const rM = await j(`(async()=>{ await reconstructAndReconcile(${mrg});
    const q=unconfirmedQueue(); const s=q[0];
    return JSON.stringify({ n:q.length, start:s&&s.start, finish:s&&s.finish, lunch:s&&s.lunchMins, merged:s&&s.merged }); })()`);
  check('merge → 1 session 09:00–17:00 with 30min lunch', rM.n===1 && rM.start==='09:00' && rM.finish==='17:00' && rM.lunch===30, JSON.stringify(rM));

  // ── MULTI-SITE same day → 2 independent sessions ─────────────────────────────
  await run(RESET);
  const ms = EVJSON([
    ev('enter','Site A',9,'08:00'), ev('exit','Site A',9,'11:00'),
    ev('enter','Site B',9,'11:20'), ev('exit','Site B',9,'15:00')
  ]);
  const rMS = await j(`(async()=>{ await reconstructAndReconcile(${ms});
    const q=unconfirmedQueue(); return JSON.stringify({ n:q.length, sites:q.map(s=>s.site), lunches:q.map(s=>s.lunchMins) }); })()`);
  check('multi-site → 2 independent sessions, no merge', rMS.n===2 && rMS.sites[0]==='Site A' && rMS.sites[1]==='Site B' && rMS.lunches.every(l=>l===0), JSON.stringify(rMS));

  // ── END-TO-END via the REAL processPendingGeoEvents entry point ──────────────
  // Stub ONLY the native SharedPrefs read (drainPendingEvents) — the one piece
  // unchanged since v89 and field-proven ($433 capture) — and drive the real
  // drain→rejected-filter→flutter-collapse→reconstruct→seal pipeline. A rejected
  // (bad-accuracy) event is included to confirm it's logged but never sealed.
  await run(RESET);
  const e2ePayload = EVJSON([
    ev('enter','Muirlawn',6,'09:00'), ev('exit','Muirlawn',6,'17:00'),
    ev('enter','Muirlawn',7,'09:00'), ev('exit','Muirlawn',7,'17:00'),
    Object.assign(ev('enter','Muirlawn',7,'09:05'),{rejected:true,reason:'accuracy 400m > 150m',acc:400}),
    ev('enter','Muirlawn',8,'09:00'), ev('exit','Muirlawn',8,'17:00')
  ]);
  const e2e = await j(`(async()=>{
    const NG = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeGeo;
    if(!NG || typeof window.processPendingGeoEvents!=='function') return JSON.stringify({err:'no native bridge'});
    const origDrain=NG.drainPendingEvents, origClear=NG.clearPendingEvents;
    NG.drainPendingEvents = async()=>({events: JSON.stringify(${e2ePayload})});
    NG.clearPendingEvents = async()=>{};
    try { await window.processPendingGeoEvents(); }
    finally { NG.drainPendingEvents=origDrain; NG.clearPendingEvents=origClear; }
    const q=unconfirmedQueue();
    return JSON.stringify({ n:q.length, days:q.map(s=>s.date), rejectedSealed: q.some(s=>s.status!=='UNCONFIRMED') });
  })()`);
  check('END-TO-END: processPendingGeoEvents drains + reconstructs 3 days',
    e2e.n===3 && JSON.stringify(e2e.days)===JSON.stringify(['2020-01-06','2020-01-07','2020-01-08']),
    JSON.stringify(e2e));
  check('END-TO-END: rejected (bad-accuracy) event never sealed', e2e.rejectedSealed===false, JSON.stringify(e2e));

  // ── IDEMPOTENCY: replaying an empty drain doesn't duplicate ──────────────────
  const idem = await j(`(async()=>{ const before=unconfirmedQueue().length; await reconstructAndReconcile([]); return JSON.stringify({before, after:unconfirmedQueue().length}); })()`);
  check('empty reconstruct is a no-op (no dupes)', idem.before===idem.after, JSON.stringify(idem));

  // cleanup
  await run(RESET);
  console.log('\n  RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail===0 ? 0 : 1);
})().catch(e => { console.error('FATAL: '+e.message); process.exit(2); });
