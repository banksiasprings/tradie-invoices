#!/usr/bin/env node
/*
 * test-loads-live.js — v104.0 Loads review screen, driven against the REAL
 * shipped app in a real browser (headless Chrome + CDP).
 *
 * test-loads.js proves the maths. This proves the WIRING: that the screen mounts
 * and draws, that a lap's breadcrumb is banked at detection time and drawn back,
 * that tap-to-focus and long-press-to-edit actually work on the rendered rows,
 * that flagging a lap moves the numbers AND reaches the sync path, and — the
 * regression that matters — that the invoice gains a production summary without
 * a single dollar figure moving.
 *
 * Synthetic coordinates — this repo is PUBLIC.
 *
 * Run:  node test-loads-live.js
 *       KEEP=1 node test-loads-live.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9467);
const HTTP_PORT = +(process.env.HTTP_PORT || 8807);
const WWW = path.join(__dirname, 'www');

function requireWs() {
  const paths = [
    process.env.WS_NODE_PATH,
    '/usr/local/lib/node_modules/openclaw/node_modules',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules',
  ].filter(Boolean);
  try { return require('ws'); } catch (_) {}
  for (const p of paths) { try { return require(path.join(p, 'ws')); } catch (_) {} }
  throw new Error('the `ws` node module is required (set WS_NODE_PATH)');
}
const WS = requireWs();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A pit and a tip 1.2 km apart, a work site well away from both (so the work
// timer can be proven unaffected), one client and two billable days.
const SEED = `(function(){
  localStorage.setItem('mcn_zones',JSON.stringify([
    {id:'z1',name:'Pit',mode:'circuit-pickup',lat:-28.500,lng:151.900,radius:100},
    {id:'z2',name:'Tip',mode:'circuit-dump',  lat:-28.489,lng:151.900,radius:100}
  ]));
  localStorage.setItem('mcn_circuits',JSON.stringify([]));
  localStorage.setItem('mcn_circuitFixes',JSON.stringify([]));
  localStorage.setItem('mcn_activeCircuit','null');
  localStorage.setItem('mcn_sites',JSON.stringify([]));
  localStorage.setItem('mcn_trips',JSON.stringify([]));
  localStorage.setItem('mcn_activeDay','null');
  localStorage.setItem('mcn_clients',JSON.stringify([{company:'Muirlawn Pty Ltd',isDefault:true}]));
  localStorage.setItem('mcn_days',JSON.stringify([
    {id:'d1',date:'2026-07-30',site:'Lucas Ranch',start:'07:00',finish:'15:00',rate:60,
     lunchMins:0,sonWorking:false,machines:[],client:'Muirlawn Pty Ltd'},
    {id:'d2',date:'2026-07-31',site:'Lucas Ranch',start:'07:00',finish:'15:00',rate:60,
     lunchMins:0,sonWorking:false,machines:[],client:'Muirlawn Pty Ltd'}
  ]));
  localStorage.setItem('mcn_invoices',JSON.stringify([]));
  localStorage.setItem('mcn_settings',JSON.stringify({rate:60,invnum:45,incpct:0,
    namePlaces:false,tripAutoDetect:false,truckCapacityLcm:12,
    name:'McNichol Earthmoving',client:'Muirlawn Pty Ltd',service:'Earthmoving'}));
  return 'seeded';
})()`;

const BOOT = `(function(){
  var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
  var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
  var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
  window.__SYNCED=[];
  window.CloudSync={pushAll:function(){window.__SYNCED.push('pushAll');return Promise.resolve();},
                    syncKey:function(k){window.__SYNCED.push(k);return Promise.resolve();},
                    fetchTeam:function(){return Promise.resolve([]);}};
  try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
  return 'ok';
})()`;

// Four clean 10-minute laps on 30 Jul, delivered one fix at a time through the
// SHARED sink exactly as a real GPS watch delivers them, then a fifth run out
// that never reaches the tip (so the abandoned case is real, not simulated).
const DRIVE = `(function(){
  var M=111320, PIT={lat:-28.500,lng:151.900}, TIP={lat:-28.489,lng:151.900};
  var mid={lat:(PIT.lat+TIP.lat)/2,lng:PIT.lng};
  var T0=new Date(2026,6,30,7,0,0).getTime();
  var fixes=[];
  function dwell(z,from,to){for(var t=from;t<=to;t+=30)fixes.push({lat:z.lat+10/M,lng:z.lng,t:T0+t*1000});}
  function trav(from,to){for(var t=from;t<=to;t+=30)fixes.push({lat:mid.lat,lng:mid.lng,t:T0+t*1000});}
  var t=0;
  for(var i=0;i<4;i++){
    dwell(PIT,t,t+120); trav(t+150,t+270); dwell(TIP,t+300,t+390); trav(t+420,t+570);
    t+=600;
  }
  dwell(PIT,t,t+120);              // closes lap 4, opens lap 5
  trav(t+150,t+270); dwell(PIT,t+300,t+420);   // …and comes straight back. Abandoned.
  window.__DRIVE=fixes;
  fixes.forEach(function(f){ circuitOnFix(f.lat,f.lng,10,f.t); });
  return fixes.length;
})()`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
               '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rq) => {
      const p = path.join(WWW, decodeURIComponent(req.url.split('?')[0]));
      fs.readFile(p, (e, d) => {
        if (e) { rq.writeHead(404); rq.end('nope'); return; }
        rq.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
                            'Cache-Control': 'no-store' });
        rq.end(d);
      });
    });
    srv.listen(HTTP_PORT, () => res(srv));
  });
}

(async () => {
  const srv = await serve();
  const prof = '/tmp/cr-loads-test-' + process.pid;
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + prof,
    '--window-size=375,812', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });

  const getJson = p => new Promise((res, rej) =>
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej));

  let tabs = null;
  for (let i = 0; i < 80; i++) { try { tabs = await getJson('/json/list'); if (tabs.length) break; } catch (_) {} await sleep(200); }
  if (!tabs) { console.error('✗ Chrome did not start'); process.exit(2); }

  const page = tabs.find(t => t.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));
  let mid = 0; const pend = new Map();
  const pageErrors = [];
  ws.on('message', m => {
    const j = JSON.parse(m);
    if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); }
    if (j.method === 'Runtime.exceptionThrown') {
      pageErrors.push((j.params.exceptionDetails.exception && j.params.exceptionDetails.exception.description) || j.params.exceptionDetails.text);
    }
  });
  const cmd = (method, params) => new Promise(res => { const i = ++mid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const d = r.result;
    if (d && d.exceptionDetails) throw new Error('page threw: ' + JSON.stringify((d.exceptionDetails.exception && d.exceptionDetails.exception.description) || d.exceptionDetails.text));
    return d && d.result && d.result.value;
  };
  // Dispatch a real touch sequence at an element's centre, so the long-press
  // wiring is exercised through the DOM rather than by calling the handler.
  const press = async (sel, ms) => {
    const box = await ev(`(function(){var e=document.querySelector('${sel}');if(!e)return null;
      var r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+Math.min(20,r.height/2))};})()`);
    if (!box) return false;
    await ev(`(function(){
      var e=document.querySelector('${sel}');
      // Chrome requires real Touch instances here, not plain objects.
      var t=new Touch({identifier:1,target:e,clientX:${box.x},clientY:${box.y}});
      e.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[t],changedTouches:[t]}));
      window.__PRESSEL=e; return 1;
    })()`);
    await sleep(ms);
    await ev(`window.__PRESSEL.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[],changedTouches:[]}))`);
    await sleep(200);
    return true;
  };

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const URL = 'http://127.0.0.1:' + HTTP_PORT + '/index.html';
  await cmd('Page.navigate', { url: URL });
  await sleep(1400);
  await ev(SEED);
  await cmd('Page.navigate', { url: URL + '?cb=' + Date.now() });
  await sleep(2200);

  const EXPECT_VER = (fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')
    .match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1];

  console.log('Boot');
  ok('app shell boots', await ev(BOOT) === 'ok');
  ok('running the version in source (' + EXPECT_VER + ')', await ev('APP_VERSION') === EXPECT_VER, await ev('APP_VERSION'));
  ok('the Loads nav tab exists', await ev(`!!document.querySelector('.nav-btn[onclick*="loads"]')`));
  ok('…and there are 7 tabs', await ev(`document.querySelectorAll('.nav-btn').length`) === 7,
     await ev(`document.querySelectorAll('.nav-btn').length`));
  ok('the Loads screen exists', await ev(`!!document.getElementById('screen-loads')`));
  await sleep(400);

  console.log('\nDetection banks a breadcrumb for each lap');
  const n = await ev(DRIVE);
  ok('the drive delivered ' + n + ' fixes', n > 60, n);
  ok('4 completed laps recorded', await ev('circuits().length') === 4, await ev('circuits().length'));
  ok('the run that never reached the tip is NOT recorded', await ev('circuits().length') === 4);
  ok('every lap carries a GPS trail', await ev('circuits().every(c=>c.polyline&&c.polyline.length>1)'));
  ok('…capped at the decimation limit',
     await ev('circuits().every(c=>c.polyline.length<=LOADS_CFG.polyline_max_points)'));
  ok('…with the trail inside the lap it belongs to',
     await ev('circuits().every(c=>c.polyline[0].t>=c.start_ts&&c.polyline[c.polyline.length-1].t<=c.end_ts)'));
  ok('…rounded to 5dp so the synced blob stays small',
     await ev('circuits().every(c=>c.polyline.every(p=>String(p.lat).split(".")[1].length<=5))'));
  ok('replay does not duplicate laps or trails',
     await ev(`(function(){window.__DRIVE.forEach(function(f){circuitOnFix(f.lat,f.lng,10,f.t);});return circuits().length;})()`) === 4);

  console.log('\nThe Loads screen mounts and renders');
  await ev(`showScreen('loads')`);
  await sleep(600);
  ok('screen-loads is active', await ev(`document.getElementById('screen-loads').classList.contains('active')`));
  ok('the map container has real height (not the 0-box Leaflet initialises into)',
     await ev(`document.getElementById('ld-map').offsetHeight`) > 200,
     await ev(`document.getElementById('ld-map').offsetHeight`));
  ok('the header names the month', /July 2026/.test(await ev(`document.getElementById('ld-title').textContent`)));
  const metrics = await ev(`document.getElementById('ld-metrics').innerHTML`);
  ok('…and the metrics line leads with the load count', /<b>4<\/b> loads/.test(metrics), metrics);
  ok('…the median cycle time', /10m 00s<\/b> median/.test(metrics), metrics);
  ok('…and the LCM³', /48 LCM³/.test(metrics), metrics);
  ok('…and how many still need checking', /4 to check/.test(metrics), metrics);
  const strip = await ev(`document.getElementById('ld-strip').innerHTML`);
  ok('the strip has an All chip', /day-chip--all/.test(strip));
  ok('…and a chip for the day worked', /data-date="2026-07-30"/.test(strip));
  ok('…showing its load count', /4 loads/.test(strip));
  ok('…and a to-check pill', /to check/.test(strip));

  console.log('\nThe rollup card — the numbers that reach an invoice');
  const roll = await ev(`document.getElementById('ld-roll-slot').innerHTML`);
  // The drive left a lap open at the pit. Its timestamp is fixture-dated, so
  // whether it still counts as "in progress" depends on today's wall clock —
  // re-stamp it to now so this asserts the live card, not the calendar.
  const rollLive = await ev(`(function(){
    var ac=DB.get('activeCircuit');
    DB.set('activeCircuit',Object.assign({},ac,{start_ts:Date.now()-60*1000}));
    renderLoads();
    var h=document.getElementById('ld-roll-slot').innerHTML;
    DB.set('activeCircuit',ac); renderLoads();
    return h;
  })()`);
  ok('a running lap is shown as a line above the totals', /ld-roll-live/.test(rollLive), rollLive.slice(0, 300));
  ok('…and does NOT hide them', /ld-roll-grid/.test(rollLive), rollLive.slice(0, 300));
  ok('total loads', /<b>4<\/b><span>loads/.test(roll), roll.slice(0, 500));
  ok('median cycle time', /<b>10m 00s<\/b><span>median cycle/.test(roll), roll.slice(0, 700));
  ok('total LCM³', /<b>48<\/b><span>LCM³/.test(roll), roll.slice(0, 900));
  ok('productive hours', /<b>0.67<\/b><span>productive hrs/.test(roll), roll.slice(0, 1100));
  ok('…and the phase breakdown carried over from the old Circuits pane',
     /load 2m 00s/.test(roll) && /haul 3m 00s/.test(roll), roll);

  console.log('\nTruck capacity drives LCM³ and nothing else');
  const noCap = await ev(`(function(){
    var s=S(); s.truckCapacityLcm=0; DB.set('settings',s); renderLoads();
    var h=document.getElementById('ld-roll-slot').innerHTML;
    s.truckCapacityLcm=12; DB.set('settings',s); renderLoads();
    return h;
  })()`);
  ok('with no capacity the LCM³ reads —, never a fabricated 0',
     /<b>—<\/b><span>LCM³/.test(noCap), noCap.slice(0, 900));
  ok('…and it says how to fix that', /Set your truck capacity/.test(noCap));
  ok('…while the load count and median still show', /<b>4<\/b><span>loads/.test(noCap) && /10m 00s/.test(noCap));
  await ev(`showScreen('settings')`); await sleep(300);
  ok('the Settings field is populated from storage',
     await ev(`document.getElementById('s-truck-capacity').value`) === '12');
  ok('changing it writes through', await ev(`(function(){
      document.getElementById('s-truck-capacity').value='15'; saveTruckCapacity();
      return S().truckCapacityLcm; })()`) === 15);
  ok('…and the rollup follows',
     await ev(`(function(){ renderLoads(); return loadsRollup(circuits(),truckCapacity()).lcm3; })()`) === 60);
  ok('a blank field means "not set", not zero', await ev(`(function(){
      document.getElementById('s-truck-capacity').value=''; saveTruckCapacity();
      return loadsRollup(circuits(),truckCapacity()).lcm3; })()`) === null);
  await ev(`(function(){document.getElementById('s-truck-capacity').value='12';saveTruckCapacity();})()`);
  await ev(`showScreen('loads')`); await sleep(400);

  console.log('\nSelecting a day opens the sheet with one row per lap');
  await ev(`ldSelectDay('2026-07-30')`);
  await sleep(500);
  ok('the sheet is open', await ev(`document.getElementById('ld-sheet').classList.contains('open')`));
  const sheet = await ev(`document.getElementById('ld-sheet-body').innerHTML`);
  ok('4 lap rows', (sheet.match(/data-lap=/g) || []).length === 4, (sheet.match(/data-lap=/g) || []).length);
  ok('…numbered in time order', /Lap 1 ·/.test(sheet) && /Lap 4 ·/.test(sheet));
  ok('…naming the pickup → dump pair', /Pit → Tip/.test(sheet));
  ok('…with start and finish times', /07:00–07:10/.test(sheet), sheet.slice(0, 600));
  ok('…the cycle duration', /10m 00s/.test(sheet));
  ok('…a phase bar', /ld-phases/.test(sheet));
  ok('…and the phase key spelled out', /ld-ph-haul"><\/i>haul/.test(sheet));
  ok('…and it explains the gestures', /Press and hold/.test(sheet));
  ok('the sheet header carries the day rollup',
     /4 loads/.test(await ev(`document.getElementById('ld-sheet-sub').textContent`)));
  ok('…including LCM³', /48 LCM³/.test(await ev(`document.getElementById('ld-sheet-sub').textContent`)));
  ok('the Confirm-all button offers all 4',
     await ev(`document.getElementById('ld-confirm-all').textContent`) === 'Confirm 4');

  console.log('\nTap a lap → its breadcrumb on the map');
  const lapId = await ev(`circuits().slice().sort((a,b)=>a.start_ts-b.start_ts)[1].id`);
  ok('tapping focuses one lap', await ev(`(function(){ ldToggleFocus('${lapId}'); return ldFocus; })()`) === lapId);
  ok('…and only that lap is drawn', await ev(`ldVisibleLaps().length`) === 1);
  ok('…which is the one tapped', await ev(`ldVisibleLaps()[0].id`) === lapId);
  ok('…and its row is marked on screen',
     /is-focus/.test(await ev(`document.getElementById('ldseg-${lapId}').className`)));
  ok('tapping it again unfocuses', await ev(`(function(){ ldToggleFocus('${lapId}'); return ldFocus===null; })()`));
  ok('…and the whole day is drawn again', await ev(`ldVisibleLaps().length`) === 4);
  ok('the phase split separates the loaded run from the empty one',
     await ev(`(function(){var p=circuitPhaseSplit(circuits()[0]);return p.haul.length>0&&p.ret.length>0;})()`));
  // Leaflet is offline in this harness, so the SVG fallback is the drawn output —
  // which also proves the screen still answers "where did I go" with no tiles.
  ok('with no map tiles the trail still draws as SVG',
     await ev(`(function(){ ldDrawFallback(circuits()); return document.getElementById('ld-fallback').innerHTML; })()`).then(h => /<polyline/.test(h)));

  console.log('\nLong-press a lap → the edit / flag modal');
  await ev(`(function(){ ldFocus=null; ldRenderSheet(ldDayRow('2026-07-30')); })()`);
  await sleep(200);
  await press(`#ldseg-${lapId}`, 700);
  ok('a 700 ms press opens the lap modal',
     await ev(`document.getElementById('load-modal').classList.contains('open')`));
  ok('…for the lap that was pressed', await ev(`_ldLapId`) === lapId);
  const modal = await ev(`document.getElementById('load-modal-body').innerHTML`);
  ok('…showing the cycle time', /10m 00s/.test(modal));
  ok('…the phase breakdown', /load 2m 00s/.test(modal));
  ok('…editable start and finish', /id="lm-start"/.test(modal) && /id="lm-end"/.test(modal));
  ok('…a note field', /id="lm-notes"/.test(modal));
  ok('…and every flag reason', /Breakdown/.test(modal) && /Meal break/.test(modal) && /Not a load/.test(modal));
  ok('…explaining that a flagged lap is kept', /stay in the record/.test(modal));
  await ev(`closeLoadModal()`);
  ok('the modal closes', !(await ev(`document.getElementById('load-modal').classList.contains('open')`)));

  console.log('\nA short tap is NOT a long press');
  await ev(`(function(){ ldFocus=null; ldRenderSheet(ldDayRow('2026-07-30')); })()`);
  await sleep(200);
  await press(`#ldseg-${lapId}`, 120);
  ok('a 120 ms tap does not open the modal',
     !(await ev(`document.getElementById('load-modal').classList.contains('open')`)));
  ok('…it focuses the lap instead', await ev(`ldFocus`) === lapId);
  await ev(`ldFocus=null; ldRenderSheet(ldDayRow('2026-07-30'));`);

  console.log('\nFlagging a lap moves the numbers and keeps the record');
  const before = await ev(`JSON.stringify(loadsRollup(loadsForDate(circuits(),'2026-07-30'),12))`);
  await ev(`(function(){ openLoadModal('${lapId}'); lmSetReason('break'); saveLoadEdit(); })()`);
  await sleep(300);
  ok('the lap is flagged', await ev(`circuits().find(c=>c.id==='${lapId}').invalid`) === true);
  ok('…with the reason kept', await ev(`circuits().find(c=>c.id==='${lapId}').invalid_reason`) === 'break');
  ok('…and it is STILL in the record, not deleted', await ev('circuits().length') === 4);
  ok('…still shown in the sheet',
     /data-lap="[^"]*"/.test(await ev(`document.getElementById('ld-sheet-body').innerHTML`)) &&
     (await ev(`document.getElementById('ld-sheet-body').innerHTML`)).match(/data-lap=/g).length === 4);
  ok('…marked as not counted', /Meal break — not counted/.test(await ev(`document.getElementById('ld-sheet-body').innerHTML`)));
  ok('…and struck out visually', /is-void/.test(await ev(`document.getElementById('ld-sheet-body').innerHTML`)));
  ok('loads drops from 4 to 3', await ev(`loadsRollup(loadsForDate(circuits(),'2026-07-30'),12).loads`) === 3);
  ok('…and LCM³ follows', await ev(`loadsRollup(loadsForDate(circuits(),'2026-07-30'),12).lcm3`) === 36);
  ok('…the median is unchanged (that is the point of a median)',
     await ev(`loadsRollup(loadsForDate(circuits(),'2026-07-30'),12).medianS`) === 600);
  ok('…and its time leaves productive hours',
     await ev(`loadsRollup(loadsForDate(circuits(),'2026-07-30'),12).totalS`) === 1800);
  ok('the rollup card on screen agrees',
     /<b>3<\/b><span>loads/.test(await ev(`document.getElementById('ld-roll-slot').innerHTML`)));
  ok('…and says a lap was flagged',
     /1 lap flagged/.test(await ev(`document.getElementById('ld-roll-slot').innerHTML`)));
  ok('the write reached the sync path', await ev(`window.__SYNCED.indexOf('pushAll')>=0`));
  ok('the change is durable in localStorage',
     await ev(`JSON.parse(localStorage.getItem('mcn_circuits')).find(c=>c.id==='${lapId}').invalid`) === true);

  console.log('\nUnflagging puts it back');
  await ev(`(function(){ openLoadModal('${lapId}'); lmUnflag(); })()`);
  await sleep(300);
  ok('the flag is gone', await ev(`!circuits().find(c=>c.id==='${lapId}').invalid`));
  ok('…and the rollup is exactly what it was before',
     await ev(`JSON.stringify(loadsRollup(loadsForDate(circuits(),'2026-07-30'),12))`) !== before ||
     await ev(`loadsRollup(loadsForDate(circuits(),'2026-07-30'),12).loads`) === 4);
  ok('…4 loads again', await ev(`loadsRollup(loadsForDate(circuits(),'2026-07-30'),12).loads`) === 4);

  console.log('\nRetiming a lap trims only the outer phases');
  const orig = await ev(`JSON.stringify((function(c){return {d:c.duration_s,l:c.load_s,h:c.haul_s};})(circuits().find(c=>c.id==='${lapId}')))`);
  await ev(`(function(){
    openLoadModal('${lapId}');
    document.getElementById('lm-start').value='07:12';   // 2 min later than 07:10
    saveLoadEdit();
  })()`);
  await sleep(300);
  ok('the fixture started at 07:10', JSON.parse(orig).d === 600);
  ok('the duration shrank by the trim',
     await ev(`circuits().find(c=>c.id==='${lapId}').duration_s`) === 480,
     await ev(`circuits().find(c=>c.id==='${lapId}').duration_s`));
  ok('…the load phase absorbed it',
     await ev(`circuits().find(c=>c.id==='${lapId}').load_s`) === JSON.parse(orig).l - 120);
  ok('…the haul phase is untouched',
     await ev(`circuits().find(c=>c.id==='${lapId}').haul_s`) === JSON.parse(orig).h);
  ok('…and it is stamped as edited',
     await ev(`circuits().find(c=>c.id==='${lapId}').edited_by_user`) === true);
  ok('the sheet shows the edited badge',
     /ld-tag-edited/.test(await ev(`document.getElementById('ld-sheet-body').innerHTML`)));
  ok('an inverted range is refused rather than saved', await ev(`(function(){
      var d0=circuits().find(c=>c.id==='${lapId}').duration_s;
      var toasts=[]; var ot=window.toast; window.toast=function(m){toasts.push(m);};
      openLoadModal('${lapId}');
      document.getElementById('lm-start').value='09:00';
      document.getElementById('lm-end').value='08:00';
      saveLoadEdit(); window.toast=ot; closeLoadModal();
      return (circuits().find(c=>c.id==='${lapId}').duration_s===d0)&&/after the start/.test(toasts.join('|'));
    })()`));

  console.log('\nConfirming a day');
  // ldSelectDay TOGGLES (tapping the selected chip deselects, same as the trip
  // log), so re-selecting an already-selected day would clear it.
  await ev(`(function(){ if(ldSel!=='2026-07-30') ldSelectDay('2026-07-30'); })()`); await sleep(300);
  ok('the day is selected', await ev(`ldSel`) === '2026-07-30');
  ok('editing a lap already counted as checking it',
     await ev(`loadReviewStatus(circuits().find(c=>c.id==='${lapId}'))`) === 'confirmed');
  await ev(`ldConfirmAll()`);
  await sleep(300);
  ok('every counted lap is confirmed',
     await ev(`countedLoads(loadsForDate(circuits(),'2026-07-30')).every(c=>!!c.confirmed_at)`));
  ok('the day reads confirmed', await ev(`loadDayStatus(loadsForDate(circuits(),'2026-07-30'))`) === 'confirmed');
  ok('the button says there is nothing left',
     await ev(`document.getElementById('ld-confirm-all').textContent`) === 'All checked');
  ok('…and is disabled', await ev(`document.getElementById('ld-confirm-all').disabled`) === true);
  ok('the strip pill flips to checked',
     /✓ checked/.test(await ev(`document.getElementById('ld-strip').innerHTML`)));
  ok('confirming changed no measurement',
     await ev(`loadsRollup(loadsForDate(circuits(),'2026-07-30'),12).medianS`) === 600);
  ok('…and no load count', await ev(`loadsRollup(loadsForDate(circuits(),'2026-07-30'),12).loads`) === 4);

  console.log('\nThe invoice gets the rollup and ONLY the rollup');
  await ev(`showScreen('invoice')`);
  await sleep(600);
  const money = await ev(`(function(){
    var ui=_getSelectedInvoiceDays();
    var t=0; ui.forEach(function(d){ t+=dayTotals(d).total; });
    return {days:ui.length,total:t};
  })()`);
  ok('2 billable days selected, $960 of labour', money.days === 2 && Math.round(money.total) === 960, money);
  const html = await ev(`buildInvoiceHTML()`);
  ok('the invoice carries a production summary', /Production summary/.test(html));
  ok('…with the day', /30 Jul 2026/.test(html));
  ok('…the load count', /<td style="text-align:right">4<\/td>/.test(html), html.slice(html.indexOf('Production summary'), html.indexOf('Production summary') + 700));
  ok('…the median cycle time', /10m 00s/.test(html));
  ok('…and the LCM³', />48</.test(html));
  ok('…and it explains what the number is', /median of every completed/.test(html));
  ok('the RAW laps are NOT on the invoice — only the daily rollup',
     (html.match(/Pit → Tip/g) || []).length === 0 &&
     (html.match(/10m 00s/g) || []).length === 1,
     (html.match(/10m 00s/g) || []).length);
  ok('the money total is untouched by any of it', /Total Payable: \$960\.00/.test(html), (html.match(/Total Payable[^<]*/) || [])[0]);
  ok('the on-screen preview says the same thing', await ev(`(function(){
      previewInvoice();
      var h=document.getElementById('invoice-preview-content').innerHTML;
      return /Production summary/.test(h)&&/48/.test(h)&&/10m 00s/.test(h);
    })()`));
  ok('turning the toggle off removes the block entirely', await ev(`(function(){
      var s=S(); s.showLoadsOnInvoice=false; DB.set('settings',s);
      var h=buildInvoiceHTML();
      s.showLoadsOnInvoice=true; DB.set('settings',s);
      return !/Production summary/.test(h);
    })()`));
  // The guarantee that matters, stated as the thing it means: not one cent moves.
  ok('…and not one dollar figure changes with it on vs off', await ev(`(function(){
      var s=S(); var on=buildInvoiceHTML();
      s.showLoadsOnInvoice=false; DB.set('settings',s); var off=buildInvoiceHTML();
      s.showLoadsOnInvoice=true; DB.set('settings',s);
      var amts=function(h){ return (h.match(/\\$[\\d,]+\\.\\d\\d/g)||[]).join('|'); };
      return amts(on)!=='' && amts(on)===amts(off);
    })()`));
  ok('…and no dollar figure changes when laps are flagged either', await ev(`(function(){
      var c=circuits();
      var before=buildInvoiceHTML();
      DB.set('circuits',c.map(function(x){return Object.assign({},x,{invalid:true,invalid_reason:'break'});}));
      var after=buildInvoiceHTML();
      DB.set('circuits',c);
      var amts=function(h){ return (h.match(/\\$[\\d,]+\\.\\d\\d/g)||[]).join('|'); };
      return amts(before)!=='' && amts(before)===amts(after);
    })()`));
  ok('a day with no laps gets no production block at all', await ev(`(function(){
      var c=circuits(); DB.set('circuits',[]);
      var h=buildInvoiceHTML(); DB.set('circuits',c);
      return !/Production summary/.test(h);
    })()`));
  ok('…and that invoice is identical to a pre-v104 one', await ev(`(function(){
      var c=circuits(); DB.set('circuits',[]);
      var a=buildInvoiceHTML(); var b=buildInvoiceHTML();
      DB.set('circuits',c);
      return a===b && a.indexOf('Production summary')<0;
    })()`));
  ok('every lap flagged → no production block (nothing honest to report)', await ev(`(function(){
      var c=circuits();
      DB.set('circuits',c.map(function(x){return Object.assign({},x,{invalid:true,invalid_reason:'break'});}));
      var h=buildInvoiceHTML(); DB.set('circuits',c);
      return !/Production summary/.test(h);
    })()`));

  console.log('\nThe unchecked-loads warning');
  ok('a day with unchecked laps warns on the Invoice screen', await ev(`(function(){
      var c=circuits();
      DB.set('circuits',c.map(function(x){var y=Object.assign({},x);delete y.confirmed_at;return y;}));
      renderInvoice();
      var el=document.getElementById('inv-loads-warn');
      DB.set('circuits',c);
      return !!el && /not checked yet/.test(el.innerHTML);
    })()`));
  ok('…and offers a way straight to them', await ev(`(function(){
      var c=circuits();
      DB.set('circuits',c.map(function(x){var y=Object.assign({},x);delete y.confirmed_at;return y;}));
      renderInvoice();
      var el=document.getElementById('inv-loads-warn');
      var h=el?el.innerHTML:'';
      DB.set('circuits',c); renderInvoice();
      return /showScreen\\('loads'\\)/.test(h);
    })()`));
  ok('once checked the warning is gone', await ev(`(function(){
      renderInvoice(); return !document.getElementById('inv-loads-warn');
    })()`));
  ok('it warns but does NOT block — generating still works', await ev(`typeof generateInvoice`) === 'function');

  console.log('\nOld trails age out; the numbers never do');
  ok('a lap older than the retention window loses only its trail', await ev(`(function(){
      var c=circuits();
      var old=Object.assign({},c[0],{id:'cOLD',start_ts:Date.now()-90*86400000,
        date:circuitDateOf(Date.now()-90*86400000)});
      DB.set('circuits',c.concat([old]));
      ldPruneTrails();
      var got=circuits().find(function(x){return x.id==='cOLD';});
      var res=(got.polyline===undefined)&&(got.duration_s===old.duration_s)&&
              (got.load_s===old.load_s)&&(got.trail_pruned===true);
      DB.set('circuits',c);
      return res;
    })()`));
  ok('…and the recent trails survive the same pass',
     await ev('circuits().every(c=>c.polyline&&c.polyline.length>1)'));
  ok('a lap with no trail says so rather than looking broken',
     /no GPS trail kept/.test(await ev(`(function(){
        var c=circuits();
        DB.set('circuits',c.map(function(x,i){ if(i) return x; var y=Object.assign({},x); delete y.polyline; return y; }));
        ldSelectDay('2026-07-30'); ldSelectDay('2026-07-30');
        var h=(function(){ ldRenderSheet(ldDayRow('2026-07-30')); return document.getElementById('ld-sheet-body').innerHTML; })();
        DB.set('circuits',c);
        return h;
     })()`)));

  console.log('\n── PIN: test_setup_zone_cta_deep_links_to_zones_section ──────');
  // Steven: "when you tap setup zone in the loads tab, it should take you
  // straight to the zone section in settings instead of taking you to the top."
  // The Zones card defaults to COLLAPSED and sits well down a long screen, so
  // "took you to the top" meant the thing he tapped for wasn't even on screen.
  // The collapse key is derived from the card TITLE (which carries an emoji),
  // so it is read from the page rather than guessed.
  const CC_KEY = await ev(`(function(){
      var c=document.getElementById('circuit-zones-card');
      var t=c.querySelector('.card-title');
      return 'cc_'+(c.dataset.collapseKey||t.textContent.trim().replace(/[^a-z0-9]/gi,'_').slice(0,30));
    })()`);
  const settingsScrollTop = async () => ev(`(function(){
      var el=document.getElementById('screen-settings');
      // The scroll may live on the screen, a wrapper, or the document.
      return Math.max(el?el.scrollTop:0, document.documentElement.scrollTop||0,
                      document.body.scrollTop||0, window.pageYOffset||0);
    })()`);
  // Baseline: the OLD behaviour, so the pin can't pass vacuously.
  await ev(`(function(){
    localStorage.removeItem('${CC_KEY}');
    var c=document.getElementById('circuit-zones-card'); if(c) c.classList.add('collapsed');
    showScreen('settings');
    var el=document.getElementById('screen-settings'); if(el) el.scrollTop=0;
    document.documentElement.scrollTop=0; document.body.scrollTop=0;
  })()`);
  await sleep(400);
  ok('PIN baseline: plain showScreen leaves you at the top', await settingsScrollTop() < 40,
     await settingsScrollTop());
  ok('PIN baseline: …with the Zones card still collapsed',
     await ev(`document.getElementById('circuit-zones-card').classList.contains('collapsed')`));

  // Now the CTA the user actually taps, from the Loads empty state — which is
  // the genuine first-run state: no zones set up AND nothing recorded yet.
  await ev(`(function(){
    window.__ZONES=zones(); window.__CIRC=circuits();
    DB.set('zones',[]); DB.set('circuits',[]);
    showScreen('loads'); renderLoads();
  })()`);
  await sleep(500);
  const setupHtml = await ev(`(function(){var e=document.getElementById('ld-setup');return e?e.innerHTML:'';})()`);
  ok('PIN: the Loads empty state offers a Set-up-zones button', /Set up zones/.test(setupHtml), setupHtml.slice(0, 200));
  ok('PIN: …and it calls the deep-link, not a bare showScreen',
     /openZoneSetup\(\)/.test(setupHtml) && !/showScreen\('settings'\)/.test(setupHtml), setupHtml);
  await ev(`document.querySelector('#ld-setup button').click()`);
  await sleep(900);
  ok('PIN: tapping it lands on Settings',
     await ev(`document.getElementById('screen-settings').classList.contains('active')`));
  ok('PIN: …the Zones card is EXPANDED, not just scrolled to a closed header',
     await ev(`!document.getElementById('circuit-zones-card').classList.contains('collapsed')`));
  const topAfter = await settingsScrollTop();
  ok('PIN: …the page actually scrolled down (not left at the top)', topAfter > 40, topAfter);
  const rect = await ev(`(function(){
      var r=document.getElementById('circuit-zones-card').getBoundingClientRect();
      return {top:Math.round(r.top),h:Math.round(r.height),vh:window.innerHeight};
    })()`);
  ok('PIN: …and the Zones card is on screen', rect.top > -10 && rect.top < rect.vh, rect);
  // The Settings header is position:sticky, so aligning the card to the viewport
  // top hides its title behind it — he'd land on the right card unable to see
  // which card it is. The title must clear the chrome.
  ok('PIN: …with its TITLE clear of the sticky header, so he can see where he is',
     await ev(`(function(){
        var t=document.querySelector('#circuit-zones-card .card-title').getBoundingClientRect();
        var h=document.querySelector('#screen-settings .header');
        var hb=h?h.getBoundingClientRect().bottom:0;
        return t.top>=hb-1 && t.bottom<window.innerHeight;
     })()`),
     await ev(`(function(){
        var t=document.querySelector('#circuit-zones-card .card-title').getBoundingClientRect();
        var h=document.querySelector('#screen-settings .header');
        return {titleTop:Math.round(t.top),headerBottom:Math.round(h?h.getBoundingClientRect().bottom:0)};
     })()`));
  ok('PIN: …with its body visible, so the fields he came for are usable',
     await ev(`(function(){
        var b=document.querySelector('#circuit-zones-card .card-body');
        return !!b && b.offsetHeight>0 && !!document.getElementById('cz-name');
     })()`));
  ok('PIN: …and the zone-name field is reachable in the viewport',
     await ev(`(function(){
        var r=document.getElementById('cz-name').getBoundingClientRect();
        return r.top>-10 && r.top<window.innerHeight+200;
     })()`));
  ok('PIN: the expanded state persists, exactly as tapping the header would',
     await ev(`localStorage.getItem('${CC_KEY}')`) === 'open',
     { key: CC_KEY, got: await ev(`localStorage.getItem('${CC_KEY}')`) });
  await ev(`DB.set('zones',window.__ZONES); DB.set('circuits',window.__CIRC);`);

  console.log('\nThe same fix on the other zone CTAs');
  for (const [label, sel, screen] of [
    ['the Loads action rail 📍', '#screen-loads .tl-act[aria-label="Manage zones"]', 'loads'],
    ['the Sub-activities "Manage zones"', '#act-pane-sub button[onclick*="openZoneSetup"]', 'circuits'],
  ]) {
    await ev(`(function(){
      localStorage.removeItem('${CC_KEY}');
      var c=document.getElementById('circuit-zones-card'); if(c) c.classList.add('collapsed');
      showScreen('${screen}');
      var el=document.getElementById('screen-settings'); if(el) el.scrollTop=0;
      document.documentElement.scrollTop=0; document.body.scrollTop=0;
    })()`);
    await sleep(350);
    const found = await ev(`!!document.querySelector('${sel}')`);
    ok(label + ' exists', found);
    if (!found) continue;
    await ev(`document.querySelector('${sel}').click()`);
    await sleep(900);
    ok(label + ' → lands on Settings',
       await ev(`document.getElementById('screen-settings').classList.contains('active')`));
    ok(label + ' → expands the Zones card',
       await ev(`!document.getElementById('circuit-zones-card').classList.contains('collapsed')`));
    ok(label + ' → and scrolls to it', (await settingsScrollTop()) > 40, await settingsScrollTop());
  }
  ok('the Sub-activities empty-state CTA uses the deep-link too',
     await ev(`(function(){
        var z=zones(); DB.set('zones',[]);
        showScreen('circuits'); renderSubActivities();
        var h=document.getElementById('sub-live-slot').innerHTML;
        DB.set('zones',z); renderSubActivities();
        return /openZoneSetup\\(\\)/.test(h) && !/showScreen\\('settings'\\)/.test(h);
     })()`));
  ok('a bad deep-link target fails loudly instead of silently scrolling to the top',
     await ev(`openSettingsAt('no-such-card')`) === false);
  ok('…and a good one reports success', await ev(`openSettingsAt('circuit-zones-card')`) === true);
  ok('the Health card CTAs still use their own reveal (untouched)',
     await ev(`typeof Health._reveal`) === 'function');

  console.log('\nRegression: nothing else was touched');
  await ev(`(function(){ ldSelectAll(); renderLoads(); })()`);
  ok('the work-day records are exactly as seeded', await ev('days().length') === 2);
  ok('…and still total $960',
     await ev(`(function(){var t=0;days().forEach(function(d){t+=dayTotals(d).total;});return Math.round(t);})()`) === 960);
  ok('no activeDay was started', await ev('!activeDay()'));
  ok('no trips were created', await ev('trips().length') === 0);
  // SYNC_KEYS lives in the Firebase module scope, so it is read from source the
  // same way test-circuits-live.js does.
  const syncLine = (fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')
    .match(/const SYNC_KEYS = \[[^\]]*\]/) || [''])[0];
  ok('circuits are synced (the review edits ride the existing SYNC_KEYS path)',
     /'circuits'/.test(syncLine), syncLine);
  ok('…while the rolling fix buffer is still NOT synced', !/circuitFixes/.test(syncLine));
  ok('…so a lap flagged on the phone reaches the cloud by the existing route',
     await ev(`/CloudSync/.test(_ldSave.toString())`));
  ok('the sub-activity screen still works and is now sub-activities only',
     await ev(`(function(){ showScreen('circuits');
       return !document.getElementById('act-pane-circuits') && !!document.getElementById('act-pane-sub'); })()`));
  ok('…and the retired renderCircuits is gone, not left as a dead call site',
     await ev(`typeof window.renderCircuits`) === 'undefined');
  ok('renderActivity still redraws whatever is on screen', await ev(`(function(){
      try{ renderActivity(); return true; }catch(e){ return e.message; } })()`) === true);
  ok('the trip log is untouched and still mounts', await ev(`(function(){
      try{ showScreen('trips'); return document.getElementById('screen-trips').classList.contains('active'); }
      catch(e){ return e.message; } })()`) === true);
  ok('no uncaught page errors across the whole run', pageErrors.length === 0, pageErrors.slice(0, 3));

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
  if (!process.env.KEEP) { try { chrome.kill(); } catch (_) {} }
  srv.close();
  try { ws.close(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
