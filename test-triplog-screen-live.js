#!/usr/bin/env node
/*
 * test-triplog-screen-live.js — v101.7 Trip Log review screen, driven against
 * the REAL shipped app in a real browser (headless Chrome + CDP).
 *
 * The pure tests in test-triplog-screen.js prove the logic. These prove the
 * WIRING, which pure tests structurally cannot: that the screen mounts, that
 * the day strip renders from mcn_trips, that tapping a day draws that day's
 * route and opens the sheet, that a category decision reaches localStorage AND
 * the Firestore sync path, and that the map fits the route instead of leaving
 * it off screen.
 *
 * No emulator needed — the screen is ordinary web code, so a real browser
 * exercises all of it in seconds. Run it after touching anything in the
 * "v101.7 TRIP LOG REVIEW SCREEN" block.
 *
 * Run:  node test-triplog-screen-live.js          (starts its own file server)
 *       KEEP=1 node test-triplog-screen-live.js   (leave Chrome running)
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9456);
const HTTP_PORT = +(process.env.HTTP_PORT || 8799);
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

// ── Fixture ──────────────────────────────────────────────────────────────────
// Same record shape v101.6 writes (see the regression pin in the pure tests).
// Synthetic coordinates in the Granite Belt — this repo is public.
const SEED = `(function(){
  function poly(la0,lo0,la1,lo1,t0,n){var a=[];for(var i=0;i<n;i++){var f=i/(n-1);
    a.push({lat:la0+(la1-la0)*f,lng:lo0+(lo1-lo0)*f,t:t0+i*60000});}return a;}
  var D=function(d,h,m){return new Date(2026,6,d,h,m).getTime();};
  function mk(id,day,h,m,mins,km,cat,extra){var t0=D(day,h,m);
    var p=poly(-28.51,151.94,-28.51-km*0.006,151.94+km*0.004,t0,12);
    return Object.assign({id:id,vehicle_id:'v1',category:cat,start_time:t0,end_time:t0+mins*60000,
      start_lat:p[0].lat,start_lng:p[0].lng,end_lat:p[11].lat,end_lng:p[11].lng,polyline:p,
      distance_km:km,duration_min:mins,notes:'',linked_site_id:null,linked_invoice_id:null,
      date:'2026-07-'+String(day).padStart(2,'0'),auto:true,edited_by_user:cat!=='unknown',
      created_at:t0},extra||{});}
  var seed=[
    mk('t1',6,7,10,42,35.5,'business',{from_label:'Stanthorpe',to_label:'Lucas Ranch'}),
    mk('t2',6,16,30,38,33.1,'unknown',{suggest_category:'business'}),
    mk('t3',9,6,55,51,44.2,'business',{approved_at:D(9,20,0)}),
    mk('t4',14,8,5,22,14.8,'personal'),
    mk('t5',14,12,0,35,28.0,'unknown'),
    mk('t6',20,7,0,64,58.6,'business',{approved_at:D(20,19,0)}),
    mk('t7',20,17,10,60,55.2,'commute',{approved_at:D(20,19,0)}),
    mk('t8',27,17,7,44,35.54,'business'),
    mk('t9',3,9,0,30,22.0,'business')      // June — must stay out of the July strip
  ];
  seed[8].date='2026-06-03';
  localStorage.setItem('mcn_trips',JSON.stringify(seed));
  localStorage.setItem('mcn_vehicles',JSON.stringify([{id:'v1',name:'City',cents_per_km:0.88,is_default:true}]));
  localStorage.setItem('mcn_sites',JSON.stringify([{id:'s1',name:'Lucas Ranch',lat:-28.72,lng:152.06,radius:2900}]));
  // Place naming off: these tests must not depend on a third-party service.
  localStorage.setItem('mcn_settings',JSON.stringify({namePlaces:false}));
  return seed.length;
})()`;

// Reveal the app shell — Firebase auth can't complete against a file server.
const BOOT = `(function(){
  var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
  var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
  var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
  try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
  var b=document.querySelector('.nav-btn[onclick*="trips"]'); if(!b) return 'no trips nav button';
  showScreen('trips',b);
  return 'ok';
})()`;

// ── Static file server ───────────────────────────────────────────────────────
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
  const prof = '/tmp/cr-triplog-test-' + process.pid;
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
  ws.on('message', m => { const j = JSON.parse(m); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } });
  const cmd = (method, params) => new Promise(res => { const i = ++mid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const d = r.result;
    if (d && d.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(d.exceptionDetails.exception && d.exceptionDetails.exception.description || d.exceptionDetails.text));
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

  console.log('Screen mounts');
  const boot = await ev(BOOT);
  ok('app shell boots and Trips tab opens', boot === 'ok', boot);
  // Read the expected version from source rather than pinning a literal — a
  // hardcoded version makes this test fail on every legitimate bump.
  const EXPECT_VER = (fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')
    .match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
  ok('running the version in source (' + EXPECT_VER + ')',
     await ev('APP_VERSION') === EXPECT_VER, await ev('APP_VERSION'));
  ok('screen-trips is the active screen', await ev(`document.getElementById('screen-trips').classList.contains('active')`));
  await sleep(2500);   // tiles + first fit
  ok('Leaflet map instantiated', await ev('!!tlMap'));
  // The container is 0-height on the tick the screen is revealed, so Leaflet
  // initialises into a zero box. The deferred invalidateSize + redraw is what
  // rescues it — this asserts the rescue worked, not that layout was instant.
  ok('map container ended up filling the viewport', await ev(`document.getElementById('tl-map').offsetHeight > 400`),
     await ev(`document.getElementById('tl-map').offsetHeight`));
  ok('Leaflet agrees on its own size', await ev(`tlMap.getSize().y > 400`), await ev(`tlMap.getSize().y`));
  ok('base tiles actually loaded', await ev(`document.querySelectorAll('#tl-map img.leaflet-tile').length`) > 0,
     await ev(`document.querySelectorAll('#tl-map img.leaflet-tile').length`));

  console.log('Day strip renders from mcn_trips');
  ok('opened on the newest month with trips', await ev('tlMonth') === '2026-07', await ev('tlMonth'));
  ok('header titles the period', await ev(`document.getElementById('tl-title').textContent`) === 'July 2026');
  const chips = await ev(`document.querySelectorAll('#tl-strip .day-chip').length`);
  ok('All chip + one chip per driven day (1 + 5)', chips === 6, chips);
  ok('June trip excluded from the July strip',
     await ev(`Array.from(document.querySelectorAll('#tl-strip .day-chip[data-date]')).map(function(e){return e.dataset.date;}).join(',')`)
     === '2026-07-06,2026-07-09,2026-07-14,2026-07-20,2026-07-27');
  const metrics = await ev(`document.getElementById('tl-metrics').textContent`);
  ok('metrics show days, km, business %, and the review count',
     /5 days/.test(metrics) && /305 km/.test(metrics) && /57% business/.test(metrics) && /2 to review/.test(metrics), metrics);
  ok('metrics are not truncated with an ellipsis', !/…/.test(metrics), metrics);
  ok('a pending day is flagged on its chip',
     /1 new/i.test(await ev(`document.querySelector('#tl-strip .day-chip[data-date="2026-07-06"] .day-chip__pill').textContent`)));
  ok('a fully-approved day reads approved',
     /approved/i.test(await ev(`document.querySelector('#tl-strip .day-chip[data-date="2026-07-20"] .day-chip__pill').textContent`)));
  ok('km bars are normalised to the busiest day (20th = 100%)',
     await ev(`document.querySelector('#tl-strip .day-chip[data-date="2026-07-20"] .day-chip__bar i').style.width`) === '100%');
  ok('month arrows offer June (an earlier month exists)',
     await ev(`!document.getElementById('tl-prev').disabled`));
  ok('month arrows do not offer a future month',
     await ev(`document.getElementById('tl-next').disabled`) === true);

  console.log('Tapping a day draws that day and opens the sheet');
  await ev(`tlSelectDay('2026-07-06')`);
  await sleep(1100);
  ok('day is selected', await ev('tlSel') === '2026-07-06');
  ok('sheet opened', await ev(`document.getElementById('tl-sheet').classList.contains('open')`));
  ok('route label names the day', /Stanthorpe → Lucas Ranch/.test(await ev(`document.getElementById('tl-route').textContent`)),
     await ev(`document.getElementById('tl-route').textContent`));
  ok('sheet lists both legs', await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg').length`) === 2);
  ok('sheet shows times and average speed',
     /07:10–07:52/.test(await ev(`document.getElementById('tl-sheet-body').textContent`)) &&
     /km\/h avg/.test(await ev(`document.getElementById('tl-sheet-body').textContent`)));
  ok('suggestion surfaced for the untagged leg',
     /Suggested: Business/.test(await ev(`document.getElementById('tl-sheet-body').textContent`)));
  // Only the selected day's trails, and only that day's — 2 trips × (casing +
  // line) + 2 endpoint dots + the Lucas Ranch site circle.
  ok('only the selected day is drawn', await ev('tlRouteLayer.getLayers().length') === 9,
     await ev('tlRouteLayer.getLayers().length'));
  // The regression that cost the most time: Leaflet drops a fit issued during a
  // zoom animation, which left the route off screen behind the sheet.
  const fit = JSON.parse(await ev(`JSON.stringify({zoom:tlMap.getZoom(),animate:tlFitOpts().animate,
      n:tlMap.getBounds().getNorth(),s:tlMap.getBounds().getSouth()})`));
  ok('programmatic fits never animate (else Leaflet drops them)', fit.animate === false);
  ok('map zoomed out to hold the whole route', fit.zoom <= 10, fit.zoom);
  ok('route bounds sit inside the visible map bounds',
     fit.n > -28.51 && fit.s < -28.723, fit);

  console.log('Categorising writes through to storage and the sync path');
  // Stub the Firestore syncKey to prove the write reaches the cloud path
  // without needing auth. `trips` is in SYNC_KEYS, so DB.set must call it.
  await ev(`(function(){ window.__synced=[];
    if(window.CloudSync){ CloudSync.uid=CloudSync.uid||'test-uid';
      CloudSync.syncKey=function(k,raw){ window.__synced.push(k); return Promise.resolve(); }; }
    return 1; })()`);
  await ev(`tlSetCat('t2','business')`);
  await sleep(400);
  const t2 = JSON.parse(await ev(`JSON.stringify(JSON.parse(localStorage.getItem('mcn_trips')).filter(function(t){return t.id==='t2';})[0])`));
  ok('category persisted to localStorage', t2.category === 'business');
  ok('approved_at stamped', typeof t2.approved_at === 'number' && t2.approved_at > 0);
  ok('edited_by_user set', t2.edited_by_user === true);
  ok('polyline survived the mutation', Array.isArray(t2.polyline) && t2.polyline.length === 12);
  ok('distance and duration untouched', t2.distance_km === 33.1 && t2.duration_min === 38);
  ok('write reached the Firestore sync path for `trips`',
     (await ev(`JSON.stringify(window.__synced)`)).indexOf('trips') >= 0, await ev(`JSON.stringify(window.__synced)`));
  // The day holds t1 (categorised long ago, never confirmed here) and t2 (just
  // approved) — so it is 'tagged', NOT 'approved'. Claiming otherwise would be
  // the vacuous-truth mistake v92.1 already had to fix once.
  ok('day chip leaves pending but does not overclaim approval',
     await ev(`tlDayRow('2026-07-06').status`) === 'tagged', await ev(`tlDayRow('2026-07-06').status`));
  ok('chip no longer advertises anything new to review',
     !/new/i.test(await ev(`document.querySelector('#tl-strip .day-chip[data-date="2026-07-06"] .day-chip__pill').textContent`)),
     await ev(`document.querySelector('#tl-strip .day-chip[data-date="2026-07-06"] .day-chip__pill').textContent`));
  ok('business % rose 57 → 68 in the header',
     /68% business/.test(await ev(`document.getElementById('tl-metrics').textContent`)),
     await ev(`document.getElementById('tl-metrics').textContent`));
  ok('nothing left to review on that day',
     !/to review/.test(await ev(`document.getElementById('tl-route').textContent`)));

  console.log('Skip returns a trip to pending (approval is a stamp, not a lock)');
  await ev(`tlSetCat('t2','skip')`);
  await sleep(300);
  const t2b = JSON.parse(await ev(`JSON.stringify(JSON.parse(localStorage.getItem('mcn_trips')).filter(function(t){return t.id==='t2';})[0])`));
  ok('category cleared', t2b.category === 'unknown');
  ok('approved_at removed', t2b.approved_at === undefined);
  ok('day chip back to pending',
     /new/i.test(await ev(`document.querySelector('#tl-strip .day-chip[data-date="2026-07-06"] .day-chip__pill').textContent`)));

  console.log('Approve all');
  await ev(`tlSelectDay('2026-07-14')`);   // 1 personal + 1 untagged, no suggestion
  await sleep(700);
  const plan = JSON.parse(await ev(`JSON.stringify(approvalPlan(tlDayRow('2026-07-14').trips))`));
  ok('only the decidable trip is offered for bulk approval', plan.approve.length === 1 && plan.skip.length === 1, plan);
  ok('button offers exactly that count',
     (await ev(`document.getElementById('tl-approve-all').textContent`)) === 'Approve 1',
     await ev(`document.getElementById('tl-approve-all').textContent`));
  await ev(`tlApproveAll()`);
  await sleep(400);
  ok('the undecidable trip was NOT silently guessed',
     await ev(`JSON.parse(localStorage.getItem('mcn_trips')).filter(function(t){return t.id==='t5';})[0].category`) === 'unknown');
  ok('day still reads pending because one leg is untagged',
     await ev(`tlDayRow('2026-07-14').status`) === 'pending', await ev(`tlDayRow('2026-07-14').status`));
  ok('the sheet explains what it skipped',
     /can't be approved in bulk/.test(await ev(`document.getElementById('tl-sheet-body').textContent`)));

  console.log('Filters and month navigation');
  await ev(`tlFilter='pending'; tlSel=null; renderTrips();`);
  await sleep(500);
  // By now t2 was skipped back to pending and t5 was never decidable, so the
  // pending filter must surface exactly those two days — and nothing else.
  ok('pending filter shows exactly the days still needing a decision',
     (await ev(`Array.from(document.querySelectorAll('#tl-strip .day-chip[data-date]')).map(function(e){return e.dataset.date;}).join(',')`))
     === '2026-07-06,2026-07-14',
     await ev(`Array.from(document.querySelectorAll('#tl-strip .day-chip[data-date]')).map(function(e){return e.dataset.date;})`));
  ok('pending filter hides the fully-approved day',
     (await ev(`Array.from(document.querySelectorAll('#tl-strip .day-chip[data-date]')).map(function(e){return e.dataset.date;}).join(',')`))
     .indexOf('2026-07-20') < 0);
  await ev(`tlFilter='business'; renderTrips();`);
  await sleep(400);
  ok('business filter excludes the personal-only day',
     (await ev(`Array.from(document.querySelectorAll('#tl-strip .day-chip[data-date]')).map(function(e){return e.dataset.date;}).join(',')`))
     .indexOf('2026-07-14') < 0);
  await ev(`tlFilter='all'; renderTrips(); tlShiftMonth(-1);`);
  await sleep(700);
  ok('stepping back lands on June', await ev('tlMonth') === '2026-06', await ev('tlMonth'));
  ok('June shows its single day', await ev(`document.querySelectorAll('#tl-strip .day-chip[data-date]').length`) === 1);
  ok('selection cleared when the month changed', await ev('tlSel') === null);

  console.log('Intra-site movement is classified and excluded live');
  // Two paddock laps wholly inside the Lucas Ranch fence + one real trip out.
  // Coordinates are offset in metres using the same spherical constant the
  // predicate uses, so "inside by 900m" really is inside.
  await ev(`(function(){
    var SITE={id:'s1',name:'Lucas Ranch',lat:-28.72,lng:152.06,radius:2900};
    localStorage.setItem('mcn_sites',JSON.stringify([SITE]));
    var M=6371000*Math.PI/180;
    function at(m){ return {lat:SITE.lat+m/M,lng:SITE.lng}; }
    var D=function(d,h,mi){ return new Date(2026,6,d,h,mi).getTime(); };
    function lap(id,day,h,offsets,km){
      var t0=D(day,h,0);
      var p=offsets.map(function(o,i){ var q=at(o); return {lat:q.lat,lng:q.lng,t:t0+i*60000}; });
      return {id:id,vehicle_id:'v1',category:'unknown',start_time:t0,end_time:t0+1800000,
        start_lat:p[0].lat,start_lng:p[0].lng,end_lat:p[p.length-1].lat,end_lng:p[p.length-1].lng,
        polyline:p,distance_km:km,duration_min:30,notes:'',
        date:'2026-07-'+String(day).padStart(2,'0'),auto:true,edited_by_user:false,created_at:t0};
    }
    var real={id:'r1',vehicle_id:'v1',category:'business',start_time:D(8,7,0),end_time:D(8,8,0),
      start_lat:SITE.lat,start_lng:SITE.lng,end_lat:-28.51,end_lng:151.94,
      polyline:[{lat:SITE.lat,lng:SITE.lng,t:D(8,7,0)},{lat:-28.60,lng:152.00,t:D(8,7,30)},{lat:-28.51,lng:151.94,t:D(8,8,0)}],
      distance_km:30,duration_min:60,notes:'',date:'2026-07-08',auto:true,edited_by_user:true,created_at:D(8,7,0)};
    setTrips([ lap('l1',8,9,[0,900,1800,900,0],6),
               lap('l2',8,13,[0,-1200,-400,0],3.5),
               real ]);
    tlMonth='2026-07'; tlSel=null; tlFilter='all'; renderTrips();
    return 1;
  })()`);
  await sleep(900);
  const stored = JSON.parse(await ev(`JSON.stringify(JSON.parse(localStorage.getItem('mcn_trips')))`));
  const byId = Object.fromEntries(stored.map(t => [t.id, t]));
  ok('paddock laps flagged intraSite and persisted', byId.l1.intraSite === true && byId.l2.intraSite === true);
  ok('the flag records which site', byId.l1.intraSite_site === 's1', byId.l1.intraSite_site);
  ok('the real outbound trip is NOT flagged', !byId.r1.intraSite);
  ok('nothing was deleted — all 3 trips still stored', stored.length === 3);
  const d8 = JSON.parse(await ev(`JSON.stringify(tlDayRow('2026-07-08'))`));
  ok('day km counts travel only (30, not 39.5)', d8.km === 30, d8.km);
  ok('on-site km reported separately (9.5)', d8.onSiteKm === 9.5, d8.onSiteKm);
  ok('on-site count is 2', d8.onSiteCount === 2, d8.onSiteCount);
  ok('untagged laps do not put the day in review', d8.pending === 0, d8.pending);
  const chipHtml = await ev(`document.querySelector('#tl-strip .day-chip[data-date="2026-07-08"]').textContent`);
  ok('chip shows travel km', /30\.0 km/.test(chipHtml), chipHtml);
  ok('chip shows the on-site count as a secondary figure', /\+2 on-site/.test(chipHtml), chipHtml);
  ok('header metrics label km as travel and carry the on-site count',
     /km travel/.test(await ev(`document.getElementById('tl-metrics').textContent`)) &&
     /\+2 on-site/.test(await ev(`document.getElementById('tl-metrics').textContent`)),
     await ev(`document.getElementById('tl-metrics').textContent`));
  await ev(`tlSelectDay('2026-07-08')`);
  await sleep(900);
  ok('all three legs still visible in the day sheet',
     await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg').length`) === 3);
  ok('on-site legs are greyed', await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg.is-onsite').length`) === 2);
  ok('on-site legs are labelled as such',
     /On-site movement/.test(await ev(`document.getElementById('tl-sheet-body').textContent`)));
  // The label must name the site, not leak its internal id.
  ok('on-site label names the site, not its id',
     /On-site movement · Lucas Ranch/.test(await ev(`document.getElementById('tl-sheet-body').textContent`)) &&
     !/· s1 —/.test(await ev(`document.getElementById('tl-sheet-body').textContent`)),
     await ev(`document.querySelector('#tl-sheet-body .tl-seg.is-onsite .tl-seg-onsite').textContent`));
  ok('route sub-line counts travel trips, with on-site alongside',
     /1 trip · \+2 on-site/.test(await ev(`document.getElementById('tl-route').textContent`)),
     await ev(`document.getElementById('tl-route').textContent`));
  ok('on-site legs offer no category buttons',
     await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg.is-onsite .tl-cat-btn').length`) === 0);
  ok('approve-all only counts the real trip',
     (await ev(`document.getElementById('tl-approve-all').textContent`)) === 'Approve 1',
     await ev(`document.getElementById('tl-approve-all').textContent`));
  ok('on-site trails still drawn on the map (nothing hidden)',
     await ev('tlRouteLayer.getLayers().length') >= 6, await ev('tlRouteLayer.getLayers().length'));
  console.log('Manual reclassification wins over the classifier');
  await ev(`tlMarkAsTravel('l1')`);
  await sleep(500);
  const l1 = JSON.parse(await ev(`JSON.stringify(JSON.parse(localStorage.getItem('mcn_trips')).filter(function(t){return t.id==='l1';})[0])`));
  ok('reclassified to travel', l1.intraSite === false && l1.intraSite_manual === true);
  ok('now counted in travel km (30 + 6)', await ev(`tlDayRow('2026-07-08').km`) === 36,
     await ev(`tlDayRow('2026-07-08').km`));
  ok('and now needs a category', await ev(`tlDayRow('2026-07-08').pending`) === 1);
  await ev(`renderTrips()`);
  await sleep(500);
  ok('a re-render does NOT undo the manual override',
     await ev(`JSON.parse(localStorage.getItem('mcn_trips')).filter(function(t){return t.id==='l1';})[0].intraSite`) === false);
  ok('the other lap is still on-site', await ev(`tlDayRow('2026-07-08').onSiteCount`) === 1);

  console.log('v104.6 — long-press a trip row to delete it');
  await ev(`(function(){
    localStorage.setItem('mcn_zones',JSON.stringify([]));
    localStorage.setItem('mcn_trips',JSON.stringify([
      {id:'tA',date:'2026-07-20',category:'business',distance_km:12.5,duration_min:20,
       start_time:Date.parse('2026-07-20T08:00:00'),end_time:Date.parse('2026-07-20T08:20:00'),
       polyline:[{lat:-28.70,lng:152.00,t:1},{lat:-28.71,lng:152.01,t:2}]},
      {id:'tB',date:'2026-07-20',category:'unknown',distance_km:3.1,duration_min:8,
       start_time:Date.parse('2026-07-20T09:00:00'),end_time:Date.parse('2026-07-20T09:08:00'),
       polyline:[{lat:-28.72,lng:152.02,t:1},{lat:-28.73,lng:152.03,t:2}]}
    ]));
    tlMonth='2026-07'; tlFilter='all'; renderTrips(); tlSelectDay('2026-07-20');
  })()`);
  await sleep(600);
  ok('both trips are in the sheet',
     (await ev(`document.querySelectorAll('#tl-sheet-body [data-trip]').length`)) === 2);
  ok('the sheet says how to remove one',
     /Press and hold/.test(await ev(`document.getElementById('tl-sheet-body').innerHTML`)));
  ok('a cancelled confirm deletes nothing', await ev(`(function(){
      var oc=window.confirm; window.confirm=function(){return false;};
      confirmDeleteTrip('tB'); window.confirm=oc;
      return trips().length; })()`) === 2);
  ok('confirming removes it from the log', await ev(`(function(){
      var oc=window.confirm; window.confirm=function(){return true;};
      var r=confirmDeleteTrip('tB'); window.confirm=oc;
      return r===true && trips().length===1 && trips()[0].id==='tA'; })()`));
  ok('…and from localStorage, durably',
     (await ev(`JSON.parse(localStorage.getItem('mcn_trips')).length`)) === 1);
  ok('…and the sheet redraws without it',
     (await ev(`document.querySelectorAll('#tl-sheet-body [data-trip]').length`)) === 1);
  ok('deleting an unknown id is handled', await ev(`(function(){
      var oc=window.confirm; window.confirm=function(){return true;};
      var r=confirmDeleteTrip('nope'); window.confirm=oc; return r===false; })()`));
  ok('the confirm copy distinguishes delete from skip', await ev(`(function(){
      var msg=''; var oc=window.confirm; window.confirm=function(m){msg=m;return false;};
      confirmDeleteTrip('tA'); window.confirm=oc;
      return /Skip instead/.test(msg) && /for good/.test(msg); })()`));

  console.log('\nv104.6 — a "don\'t record here" zone hides trips around home');
  await ev(`(function(){
    localStorage.setItem('mcn_zones',JSON.stringify([
      {id:'zh',name:'Home',mode:'disregard',lat:-28.400,lng:151.800,radius:400}
    ]));
    var M=111320;
    localStorage.setItem('mcn_trips',JSON.stringify([
      {id:'tHome',date:'2026-07-21',category:'unknown',distance_km:1.2,duration_min:6,
       start_time:Date.parse('2026-07-21T08:00:00'),end_time:Date.parse('2026-07-21T08:06:00'),
       polyline:[{lat:-28.400,lng:151.800,t:1},{lat:-28.400+120/M,lng:151.800,t:2}]},
      {id:'tReal',date:'2026-07-21',category:'business',distance_km:22.0,duration_min:30,
       start_time:Date.parse('2026-07-21T09:00:00'),end_time:Date.parse('2026-07-21T09:30:00'),
       polyline:[{lat:-28.400,lng:151.800,t:1},{lat:-28.400+4000/M,lng:151.800,t:2}]}
    ]));
    tlMonth='2026-07'; tlFilter='all'; tlSel=null; renderTrips();
  })()`);
  await sleep(700);
  ok('the home trip is flagged on render', await ev(`trips().find(function(t){return t.id==='tHome';}).disregarded`) === true);
  ok('…and the real trip is not', await ev(`!trips().find(function(t){return t.id==='tReal';}).disregarded`));
  ok('only the real trip is in the default view', await ev(`tlMonthTrips().length`) === 1);
  ok('…and it is the right one', await ev(`tlMonthTrips()[0].id`) === 'tReal');
  ok('the month km excludes the home pottering',
     /22/.test(await ev(`document.getElementById('tl-metrics').innerHTML`)),
     await ev(`document.getElementById('tl-metrics').innerHTML`));
  ok('the hidden trip is reachable under its own filter', await ev(`(function(){
      tlFilter='disregarded'; renderTrips();
      return tlMonthTrips().length===1 && tlMonthTrips()[0].id==='tHome'; })()`));
  await ev(`tlSelectDay('2026-07-21')`); await sleep(500);
  ok('…the row explains why it is hidden',
     /Not recorded/.test(await ev(`document.getElementById('tl-sheet-body').innerHTML`)),
     (await ev(`document.getElementById('tl-sheet-body').innerHTML`)).slice(0, 300));
  ok('…naming the zone', /inside Home/.test(await ev(`document.getElementById('tl-sheet-body').innerHTML`)));
  ok('…and offers the way back', /tlUndisregard/.test(await ev(`document.getElementById('tl-sheet-body').innerHTML`)));
  ok('putting it back works and sticks', await ev(`(function(){
      tlUndisregard('tHome');
      var t=trips().find(function(x){return x.id==='tHome';});
      return t.disregarded===undefined && t.disregard_manual===true; })()`));
  ok('…and a re-render does not re-hide it', await ev(`(function(){
      tlFilter='all'; renderTrips();
      return !trips().find(function(x){return x.id==='tHome';}).disregarded; })()`));
  await ev(`(function(){ localStorage.setItem('mcn_zones',JSON.stringify([])); tlFilter='all'; tlSel=null; })()`);

  console.log('Empty and offline states');
  await ev(`(function(){ setTrips([]); tlMonth=null; tlSel=null; renderTrips(); return 1; })()`);
  await sleep(500);
  ok('no trips renders without throwing',
     await ev(`document.querySelectorAll('#tl-strip .day-chip').length`) >= 1);
  ok('strip says so rather than showing a blank rail',
     /No trips this month/.test(await ev(`document.getElementById('tl-strip').textContent`)),
     await ev(`document.getElementById('tl-strip').textContent`));
  const errs = await ev(`JSON.stringify(window.__pageErrors||[])`);
  ok('no uncaught page errors across the whole run', errs === '[]' || errs === undefined, errs);

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
  ws.close();
  if (!process.env.KEEP) { chrome.kill(); try { execSync('rm -rf ' + prof); } catch (_) {} }
  srv.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('✗ harness error:', e.message); process.exit(2); });
