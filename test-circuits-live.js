#!/usr/bin/env node
/*
 * test-circuits-live.js — v102.0 circuit timer, driven against the REAL shipped
 * app in a real browser (headless Chrome + CDP).
 *
 * The pure tests in test-circuits.js prove the detection logic. These prove the
 * WIRING: that fixes arriving through the SHARED sink (checkNearbySites — the
 * same one fed by the GPS watch, the 90s poll and the v101.6 TripLogService
 * replay) actually produce circuit records, that replay is idempotent, that the
 * screen renders them, that the CSV is well-formed, and — the regression that
 * matters — that none of it touches the work timer, the trip log, or money.
 *
 * Run:  node test-circuits-live.js
 *       KEEP=1 node test-circuits-live.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9465);
const HTTP_PORT = +(process.env.HTTP_PORT || 8805);
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

// Two zones 1.2 km apart, plus an unrelated work site so we can prove the work
// timer is unaffected. Synthetic coordinates — this repo is PUBLIC.
const SEED = `(function(){
  localStorage.setItem('mcn_zones',JSON.stringify([
    {id:'z1',name:'Pit',kind:'pickup',lat:-28.500,lng:151.900,radius:100},
    {id:'z2',name:'Tip',kind:'dump',  lat:-28.489,lng:151.900,radius:100}
  ]));
  localStorage.setItem('mcn_circuits',JSON.stringify([]));
  localStorage.setItem('mcn_circuitFixes',JSON.stringify([]));
  localStorage.setItem('mcn_activeCircuit','null');
  localStorage.setItem('mcn_sites',JSON.stringify([]));
  localStorage.setItem('mcn_days',JSON.stringify([]));
  localStorage.setItem('mcn_trips',JSON.stringify([]));
  localStorage.setItem('mcn_activeDay','null');
  localStorage.setItem('mcn_settings',JSON.stringify({rate:60,namePlaces:false,tripAutoDetect:false}));
  return 'seeded';
})()`;

const BOOT = `(function(){
  var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
  var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
  var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
  window.CloudSync={pushAll:function(){return Promise.resolve();},syncKey:function(){return Promise.resolve();},
                    fetchTeam:function(){return Promise.resolve([]);}};
  try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
  return 'ok';
})()`;

// The drive, delivered one fix at a time through the SHARED sink, exactly the
// way a real GPS watch delivers them. Two full cycles at 30 s sampling.
const DRIVE = `(function(){
  var M=111320, PIT={lat:-28.500,lng:151.900}, TIP={lat:-28.489,lng:151.900};
  var T0=new Date(2026,6,30,7,0,0).getTime();
  var mid={lat:(PIT.lat+TIP.lat)/2,lng:PIT.lng};
  var fixes=[];
  function push(z,from,to){for(var t=from;t<=to;t+=30)fixes.push({lat:z.lat+10/M,lng:z.lng,t:T0+t*1000});}
  function trav(from,to){for(var t=from;t<=to;t+=30)fixes.push({lat:mid.lat,lng:mid.lng,t:T0+t*1000});}
  push(PIT,0,180); trav(210,390); push(TIP,420,540); trav(570,750);
  push(PIT,780,960); trav(990,1170); push(TIP,1200,1320); trav(1350,1530);
  push(PIT,1560,1740);
  window.__DRIVE=fixes;
  // Feed them through circuitOnFix with an explicit timestamp, which is what the
  // shared sink does for a replayed fix.
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
  const prof = '/tmp/cr-circ-test-' + process.pid;
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

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

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
  ok('zones loaded from storage', await ev('zones().length') === 2);
  await sleep(400);

  console.log('\nDetection through the SHARED fix sink');
  const n = await ev(DRIVE);
  ok('the drive delivered ' + n + ' fixes', n > 40, n);
  ok('two circuits recorded', await ev('circuits().length') === 2, await ev('circuits().length'));
  ok('…the first is Pit → Tip',
     await ev(`circuits()[0].pickup_name+'→'+circuits()[0].dump_name`) === 'Pit→Tip');
  ok('…13 minute cycle', await ev('circuits()[0].duration_s') === 780);
  ok('…with the phases broken out',
     await ev(`[circuits()[0].load_s,circuits()[0].haul_s,circuits()[0].dump_s,circuits()[0].return_s].join(',')`) === '180,240,120,240');
  ok('…filed under the LOCAL date, not UTC', await ev('circuits()[0].date') === '2026-07-30');
  ok('…with a stable id derived from the start', await ev('circuits()[0].id') === 'c' + new Date(2026, 6, 30, 7, 0, 0).getTime());
  ok('a cycle is left open (he is back at the pit)', await ev('!!DB.get("activeCircuit")'));
  ok('…and it knows where it started', await ev('DB.get("activeCircuit").pickup_name') === 'Pit');

  console.log('\nReplay is idempotent (the queue can be drained twice)');
  await ev(`window.__DRIVE.forEach(function(f){ circuitOnFix(f.lat,f.lng,10,f.t); });`);
  ok('re-feeding the same fixes adds nothing', await ev('circuits().length') === 2);
  await ev(`applyBankedCircuitFixes(window.__DRIVE)`);
  ok('replaying them as a banked batch adds nothing either', await ev('circuits().length') === 2);
  ok('…and the banked-batch path is the one TripLogService feeds',
     await ev(`typeof window.applyBankedCircuitFixes`) === 'function');

  console.log('\nJunk fixes are refused');
  const before = await ev('DB.def("circuitFixes",[]).length');
  await ev(`circuitOnFix(-28.500,151.900,250,Date.now())`);
  ok('a 250 m-accuracy fix is not banked (a 100 m zone cannot be resolved by it)',
     await ev('DB.def("circuitFixes",[]).length') === before);
  await ev(`(function(){var z=zones();DB.set('zones',[]);circuitOnFix(-28.5,151.9,10,Date.now());DB.set('zones',z);})()`);
  ok('with no zones set up nothing is banked at all',
     await ev('DB.def("circuitFixes",[]).length') === before);

  console.log('\nThe Circuits screen');
  await ev(`showScreen('circuits')`);
  await sleep(400);
  ok('screen-circuits is active', await ev(`document.getElementById('screen-circuits').classList.contains('active')`));
  const live = await ev(`document.getElementById('circuit-live-slot').innerHTML`);
  ok('the live card shows a cycle in progress', /Cycle in progress/.test(live));
  ok('…naming the pickup it started from', /Pit/.test(live));
  const stats = await ev(`document.getElementById('circuit-stats-slot').innerHTML`);
  ok('averages are shown', /Averages/.test(stats));
  ok('…for the Pit → Tip run', /Pit → Tip/.test(stats));
  ok('…counting 2 laps', /<b>2<\/b>/.test(stats), stats.slice(0, 400));
  ok('…with a 13m 00s average', /13m 00s/.test(stats));
  ok('…and the phase breakdown Steven can act on', /load 3m 00s/.test(stats) && /haul 4m 00s/.test(stats));
  const list = await ev(`document.getElementById('circuit-list-slot').innerHTML`);
  ok('both laps are listed', (list.match(/Pit → Tip/g) || []).length === 2, (list.match(/Pit → Tip/g) || []).length);
  ok('…under the day heading with a day total', /30 Jul 2026/.test(list) && /2 laps/.test(list));
  ok('the live timer ticks only while the screen is open', await ev('!!_circuitTick'));
  await ev(`showScreen('log')`);
  ok('…and stops when you leave', await ev('!_circuitTick'));
  await ev(`showScreen('circuits')`);

  console.log('\nAn open cycle goes stale instead of counting forever');
  // Found by looking at the rendered screen: an open cycle from the morning read
  // "CYCLE IN PROGRESS 10h 30m" that evening.
  const staleHtml = await ev(`(function(){
    var ac=DB.get('activeCircuit');
    DB.set('activeCircuit',{pickup_zone_id:'z1',pickup_name:'Pit',
      start_ts:Date.now()-10*3600*1000,dump_name:null,dump_ts:null});
    renderCircuits();
    var h=document.getElementById('circuit-live-slot').innerHTML;
    DB.set('activeCircuit',ac); renderCircuits();
    return h;
  })()`);
  ok('a 10-hour-old cycle does NOT show a running timer', !/Cycle in progress/i.test(staleHtml), staleHtml.slice(0, 200));
  ok('…it says no cycle is running', /No cycle running/.test(staleHtml));
  ok('…and explains that the lap was not counted', /never came back/.test(staleHtml));
  ok('the live card is back to normal afterwards',
     /Cycle in progress/i.test(await ev(`document.getElementById('circuit-live-slot').innerHTML`)));

  console.log('\nCSV export');
  const csv = await ev(`(function(){
    var got=null; var orig=window.shareOrDownload;
    window.shareOrDownload=function(blob,name){ got={name:name,type:blob.type}; return Promise.resolve(); };
    exportCircuitsCSV();
    window.shareOrDownload=orig;
    return got;
  })()`);
  ok('export produces a CSV file', csv && /\.csv$/.test(csv.name), csv);
  ok('…named for the date', /^circuits_2026-\d\d-\d\d\.csv$/.test(csv.name) || /^circuits_\d{4}-\d\d-\d\d\.csv$/.test(csv.name), csv.name);
  ok('…with the right MIME type', csv.type === 'text/csv');
  // Check the content itself by rebuilding it the same way the exporter does.
  const body = await ev(`(function(){
    var body=null; var orig=window.shareOrDownload;
    window.shareOrDownload=function(blob){ body=blob; return Promise.resolve(); };
    exportCircuitsCSV(); window.shareOrDownload=orig;
    return body ? body.text() : null;
  })()`);
  ok('CSV has a summary-by-run block', /Summary by run/.test(body));
  ok('…and a row per circuit', /Every circuit/.test(body));
  ok('…listing both laps', (body.match(/Pit","Tip"/g) || []).length >= 2, (body.match(/Pit","Tip"/g) || []).length);
  ok('…with cycle minutes for billing analysis', /"13\.00"/.test(body));
  // Blob.text() runs a UTF-8 decode, which strips a leading BOM — so the bytes
  // have to be checked directly or this silently passes on a BOM-less file.
  const bom = await ev(`(function(){
    var b=null; var orig=window.shareOrDownload;
    window.shareOrDownload=function(blob){ b=blob; return Promise.resolve(); };
    exportCircuitsCSV(); window.shareOrDownload=orig;
    return b.arrayBuffer().then(function(buf){ return Array.from(new Uint8Array(buf.slice(0,3))); });
  })()`);
  ok('…UTF-8 BOM so Excel on Windows opens it correctly',
     JSON.stringify(bom) === JSON.stringify([0xEF, 0xBB, 0xBF]), bom);
  ok('…CRLF line endings', /\r\n/.test(body));
  ok('exporting with nothing logged does not throw',
     await ev(`(function(){var c=circuits();DB.set('circuits',[]);var e=null;
       try{exportCircuitsCSV();}catch(x){e=x.message;}DB.set('circuits',c);return e;})()`) === null);

  console.log('\nZone setup');
  await ev(`showScreen('settings')`);
  await sleep(400);
  const zl = await ev(`document.getElementById('circuit-zones-list').innerHTML`);
  ok('both zones listed in Settings', /Pit/.test(zl) && /Tip/.test(zl));
  ok('…labelled pickup and dump', /Pickup/.test(zl) && /Dump/.test(zl));
  ok('overlapping zones are refused rather than logged ambiguously',
     await ev(`(function(){
       var toasts=[]; var ot=window.toast; window.toast=function(m){toasts.push(m);};
       document.getElementById('cz-name').value='Overlap';
       _czLat=-28.5001; _czLng=151.9001;
       document.getElementById('cz-radius').value=100;
       czSave();
       window.toast=ot;
       return toasts.join('|');
     })()`).then(t => /overlaps/.test(t)));
  ok('…so the zone count is unchanged', await ev('zones().length') === 2);
  ok('a zone with no location captured is refused',
     await ev(`(function(){
       var toasts=[]; var ot=window.toast; window.toast=function(m){toasts.push(m);};
       document.getElementById('cz-name').value='No GPS'; _czLat=null;
       czSave(); window.toast=ot; return toasts.join('|');
     })()`).then(t => /Capture the location/.test(t)));
  ok('an unnamed zone is refused',
     await ev(`(function(){
       var toasts=[]; var ot=window.toast; window.toast=function(m){toasts.push(m);};
       document.getElementById('cz-name').value=''; _czLat=-28.6; _czLng=151.8;
       czSave(); window.toast=ot; return toasts.join('|');
     })()`).then(t => /name/.test(t)));
  ok('a valid, non-overlapping zone IS accepted',
     await ev(`(function(){
       document.getElementById('cz-name').value='Far pit'; _czLat=-28.60; _czLng=151.90;
       document.getElementById('cz-radius').value=100; czSetKind('pickup'); czSave();
       return zones().length;
     })()`) === 3);

  console.log('\nRegression: nothing else was touched');
  ok('no work-day records were created', await ev('days().length') === 0);
  ok('no activeDay was started', await ev('!activeDay()'));
  ok('no trips were created', await ev('trips().length') === 0);
  // SYNC_KEYS lives in the Firebase module scope, so it is read from source
  // rather than the page. The rule it encodes matters: a rolling GPS buffer and
  // a live cursor must never sync, or every fix becomes a Firestore write.
  const syncLine = (fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')
    .match(/const SYNC_KEYS = \[([^\]]*)\]/) || [])[1] || '';
  ok('circuits + zones are synced', /'circuits'/.test(syncLine) && /'zones'/.test(syncLine), syncLine);
  ok('…while the rolling fix buffer is NOT (no write-spam mid-shift)', !/circuitFixes/.test(syncLine));
  ok('…and neither is the live cursor', !/activeCircuit/.test(syncLine));
  ok('circuitOnFix is called from the one shared sink, not a new GPS service',
     await ev(`/circuitOnFix/.test(checkNearbySites.toString())`));
  ok('…exactly once, so a fix is never double-counted',
     await ev(`(checkNearbySites.toString().match(/circuitOnFix\\(/g)||[]).length`) === 1);
  ok('…and it is guarded, so an older bundle without it cannot break the sink',
     await ev(`/window\\.circuitOnFix/.test(checkNearbySites.toString())`));
  ok('no uncaught page errors across the whole run', pageErrors.length === 0, pageErrors);

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
  if (!process.env.KEEP) { try { chrome.kill(); } catch (_) {} srv.close(); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); process.exit(2); });
