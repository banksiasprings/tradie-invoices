#!/usr/bin/env node
/*
 * test-sessions.js — unit tests for the v90 PURE session reconstruction logic.
 *
 * Extracts buildSessionsFromEvents() VERBATIM from www/index.html (between the
 * //__V90_BUILDER_START__ / //__V90_BUILDER_END__ markers) and runs it against
 * synthetic native geo-event sequences. Tests the SHIPPED source — no copy, no
 * drift. Pure logic → no emulator/browser needed → sub-second feedback loop.
 *
 * This is the heart of "set and forget": it proves that a week of ENTER/EXIT
 * events banked while the app was closed reconstructs into the right sessions.
 *
 * Run:  node test-sessions.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
const m = html.match(/\/\/__V90_BUILDER_START__[^\n]*\n([\s\S]*?)\/\/__V90_BUILDER_END__/);
if (!m) { console.error('✗ could not find builder markers in www/index.html'); process.exit(2); }
// eval the extracted source inside an isolated Function scope, return the fn
const buildSessionsFromEvents = new Function(m[1] + '\nreturn buildSessionsFromEvents;')();

// ── helpers ──────────────────────────────────────────────────────────────────
// Brisbane is UTC+10 (no DST). Build a ms timestamp from a local date+time so
// the test is timezone-independent regardless of where it runs.
function ts(dateStr, timeStr){
  const [Y,M,D] = dateStr.split('-').map(Number);
  const [h,mi]  = timeStr.split(':').map(Number);
  return Date.UTC(Y, M-1, D, h-10, mi); // -10h to convert AEST→UTC
}
function ev(type, site, date, time){ return { type, site, date, time, timestamp: ts(date,time) }; }
const DEFS = { rate:60, sonrate:30 };
let seed = 1;
function build(events, opts){
  return buildSessionsFromEvents(events, Object.assign({
    sessionDefaults: DEFS, mergeWindowMin: 90,
    mkId: () => 's' + (seed++)
  }, opts||{}));
}

let pass=0, fail=0;
function check(name, cond, detail){
  if(cond){ console.log('  ✓ '+name); pass++; }
  else { console.log('  ✗ '+name + (detail?('\n      '+detail):'')); fail++; }
}

// ── 1. Single day (the validated 2026-07-01 $433 scenario) ───────────────────
(() => {
  const r = build([ ev('enter','Muirlawn','2026-07-01','09:37'), ev('exit','Muirlawn','2026-07-01','16:50') ]);
  check('single day → 1 completed session, no open',
    r.completed.length===1 && r.open===null,
    JSON.stringify({completed:r.completed.length, open:!!r.open}));
  const s=r.completed[0];
  check('single day → correct site/start/finish',
    s && s.site==='Muirlawn' && s.start==='09:37' && s.finish==='16:50' && s.status==='UNCONFIRMED',
    JSON.stringify(s));
})();

// ── 2. FLAGSHIP: 5-day week, app never opened, opened Fri night ───────────────
(() => {
  const days=['2026-06-29','2026-06-30','2026-07-01','2026-07-02','2026-07-03'];
  const events=[];
  days.forEach(d=>{ events.push(ev('enter','Muirlawn',d,'09:00')); events.push(ev('exit','Muirlawn',d,'17:00')); });
  const r = build(events);
  check('5-day week → 5 completed sessions, no open',
    r.completed.length===5 && r.open===null,
    JSON.stringify({completed:r.completed.length, open:!!r.open}));
  check('5-day week → each is a distinct day 09:00–17:00',
    r.completed.every((s,i)=> s.date===days[i] && s.start==='09:00' && s.finish==='17:00'),
    JSON.stringify(r.completed.map(s=>s.date+' '+s.start+'-'+s.finish)));
  check('5-day week → unique ids',
    new Set(r.completed.map(s=>s.id)).size===5);
})();

// ── 3. Same-day rejoin merge (off-site lunch, 30 min < 90) ───────────────────
(() => {
  const r = build([
    ev('enter','Muirlawn','2026-07-01','09:00'),
    ev('exit','Muirlawn','2026-07-01','12:00'),
    ev('enter','Muirlawn','2026-07-01','12:30'),   // 30 min gap → merge
    ev('exit','Muirlawn','2026-07-01','17:00')
  ]);
  check('merge → 1 session (not 2)', r.completed.length===1 && r.open===null,
    JSON.stringify({completed:r.completed.length}));
  const s=r.completed[0];
  check('merge → spans 09:00–17:00 with 30min lunch',
    s && s.start==='09:00' && s.finish==='17:00' && s.lunchMins===30 && s.merged===true,
    JSON.stringify(s && {start:s.start,finish:s.finish,lunch:s.lunchMins,merged:s.merged}));
})();

// ── 4. Gap LONGER than merge window (120 min) → two separate sessions ─────────
(() => {
  const r = build([
    ev('enter','Muirlawn','2026-07-01','09:00'),
    ev('exit','Muirlawn','2026-07-01','12:00'),
    ev('enter','Muirlawn','2026-07-01','14:00'),   // 120 min gap → NO merge
    ev('exit','Muirlawn','2026-07-01','17:00')
  ]);
  check('long gap → 2 separate sessions', r.completed.length===2 && r.open===null,
    JSON.stringify({completed:r.completed.length}));
})();

// ── 5. Multi-site same day → 2 independent sessions (no merge across sites) ───
(() => {
  const r = build([
    ev('enter','Site A','2026-07-01','08:00'),
    ev('exit','Site A','2026-07-01','11:00'),
    ev('enter','Site B','2026-07-01','11:20'),     // 20 min but DIFFERENT site → no merge
    ev('exit','Site B','2026-07-01','15:00')
  ]);
  check('multi-site → 2 independent sessions', r.completed.length===2 && r.open===null,
    JSON.stringify(r.completed.map(s=>s.site+' '+s.start+'-'+s.finish)));
  check('multi-site → sites A then B, no lunch merged',
    r.completed[0].site==='Site A' && r.completed[1].site==='Site B' &&
    r.completed[0].lunchMins===0 && r.completed[1].lunchMins===0);
})();

// ── 6. Dangling ENTER (still on site) → open session, no completed ───────────
(() => {
  const r = build([ ev('enter','Muirlawn','2026-07-01','09:00') ]);
  check('dangling enter → open session, 0 completed',
    r.completed.length===0 && r.open && r.open.site==='Muirlawn' && r.open.start==='09:00' && !r.open.finish,
    JSON.stringify({completed:r.completed.length, open:r.open&&r.open.start}));
})();

// ── 7. Carried-in openSession + a later EXIT closes it ───────────────────────
(() => {
  const openSess = { id:'live1', site:'Muirlawn', date:'2026-07-01', start:'09:00',
    startTs: ts('2026-07-01','09:00'), finish:null, lunchMins:0, status:'UNCONFIRMED' };
  const r = build([ ev('exit','Muirlawn','2026-07-01','17:00') ], { openSession: openSess });
  check('carried openSession + exit → completes it, id preserved (caller supersedes by id)',
    r.completed.length===1 && r.completed[0].id==='live1' && r.completed[0].finish==='17:00' && r.open===null,
    JSON.stringify({completed:r.completed.length, id:r.completed[0]&&r.completed[0].id}));
})();

// ── 8. Cross-drain merge: recentUnconfirmed + re-enter within window ──────────
(() => {
  const recent = [{ id:'u1', site:'Muirlawn', date:'2026-07-01', start:'09:00', finish:'12:00',
    startTs: ts('2026-07-01','09:00'), finishTs: ts('2026-07-01','12:00'), lunchMins:0, status:'UNCONFIRMED' }];
  const r = build([ ev('enter','Muirlawn','2026-07-01','12:40'), ev('exit','Muirlawn','2026-07-01','17:00') ],
    { recentUnconfirmed: recent });
  check('cross-drain merge → reuses u1, 40min lunch, 09:00–17:00',
    r.completed.length===1 && r.completed[0].id==='u1' && r.completed[0].lunchMins===40 &&
    r.completed[0].start==='09:00' && r.completed[0].finish==='17:00',
    JSON.stringify(r.completed[0] && {id:r.completed[0].id,lunch:r.completed[0].lunchMins,s:r.completed[0].start,f:r.completed[0].finish}));
})();

// ── 9. Out-of-order arrival of events still sorts by timestamp ───────────────
(() => {
  const r = build([
    ev('exit','Muirlawn','2026-07-01','17:00'),
    ev('enter','Muirlawn','2026-07-01','09:00')
  ]);
  check('out-of-order → sorted into 1 session 09:00–17:00',
    r.completed.length===1 && r.completed[0].start==='09:00' && r.completed[0].finish==='17:00',
    JSON.stringify(r.completed[0]&&{s:r.completed[0].start,f:r.completed[0].finish}));
})();

// ── 10. Stray exit with no enter → ignored ───────────────────────────────────
(() => {
  const r = build([ ev('exit','Muirlawn','2026-07-01','17:00') ]);
  check('stray exit → nothing built', r.completed.length===0 && r.open===null);
})();

// ── 11. Missed exit then next-day enter → prior day sealed incomplete ─────────
(() => {
  const r = build([
    ev('enter','Muirlawn','2026-07-01','09:00'),   // exit missed
    ev('enter','Muirlawn','2026-07-02','09:00'),
    ev('exit','Muirlawn','2026-07-02','17:00')
  ]);
  check('missed exit → 2 sessions (day1 incomplete, day2 complete)',
    r.completed.length===2 && r.open===null &&
    r.completed[0].date==='2026-07-01' && !r.completed[0].finish &&
    r.completed[1].date==='2026-07-02' && r.completed[1].finish==='17:00',
    JSON.stringify(r.completed.map(s=>s.date+' '+s.start+'-'+(s.finish||'?'))));
})();

console.log('\n  RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail===0 ? 0 : 1);
