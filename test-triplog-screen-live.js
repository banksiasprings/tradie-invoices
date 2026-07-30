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
  // v105.2: on-site legs now fold into one Worksite-travel row by default, so
  // the travel leg shows individually and the two on-site ones are behind it.
  ok('the travel leg is drawn individually',
     await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg[data-trip]:not(.is-onsite)').length`) === 1);
  ok('the two on-site legs are folded into one Worksite-travel row',
     await ev(`(function(){ var g=document.querySelector('#tl-sheet-body .tl-onsite-group');
        return !!g && /2 trips/.test(g.textContent); })()`),
     await ev(`(document.querySelector('#tl-sheet-body .tl-onsite-group')||{}).textContent`));
  // Expand to check the individual legs still read correctly underneath.
  await ev(`tlToggleOnSite('2026-07-08')`);
  await sleep(400);
  ok('all three legs are there once expanded',
     await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg[data-trip]').length`) === 3);
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

  console.log("v104.8 — a trip finishes: no popup, silent add, badge counts up");
  await ev(`(function(){
    localStorage.setItem('mcn_zones',JSON.stringify([]));
    localStorage.setItem('mcn_trips',JSON.stringify([]));
    localStorage.setItem('mcn_vehicles',JSON.stringify([{id:'v1',name:'Hilux',registration:'123ABC',cents_per_km:0.88,is_default:true}]));
    var s=S(); delete s.confirmTripsOnFinish; s.tripAutoDetect=true; DB.set('settings',s);
    localStorage.removeItem('mcn_tripVehPrompted');
    renderTrips();
  })()`);
  await sleep(400);
  ok('the setting defaults to OFF', await ev(`S().confirmTripsOnFinish===true`) === false);
  ok('no trips, so no count is shown',
     await ev(`document.getElementById('nav-trips-count').style.display`) === 'none');

  // A trip finishes exactly as the detector seals one — auto:true and a fresh
  // created_at, which is what makes it ELIGIBLE for the prompt. Without those
  // the "no popup" assertions below would pass for the wrong reason.
  const finish = tid => ev(`(function(){
    var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
    var T0=Date.parse('2026-07-22T09:00:00');
    var all=trips();
    all.push({id:'${tid}',date:'2026-07-22',category:'unknown',distance_km:14.2,duration_min:18,
      auto:true,created_at:Date.now(),
      start_time:T0,end_time:T0+18*60000,
      polyline:[{lat:-28.70,lng:152.00,t:T0},{lat:-28.72,lng:152.03,t:T0+18*60000}]});
    setTrips(all);
    maybePromptTripVehicle();          // the trip-end hook, called exactly as initTripLog does
    return true;
  })()`);

  // Prove the fixture really would prompt, so "no popup" means the SETTING
  // suppressed it rather than the trip simply not qualifying.
  await ev(`(function(){
    var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
    var s=S(); s.confirmTripsOnFinish=true; DB.set('settings',s);
    var T0=Date.parse('2026-07-22T09:00:00');
    setTrips([{id:'probe',date:'2026-07-22',category:'unknown',distance_km:1,duration_min:2,
      auto:true,created_at:Date.now(),start_time:T0,end_time:T0+120000,
      polyline:[{lat:-28.7,lng:152,t:T0}]}]);
    maybePromptTripVehicle();
  })()`);
  await sleep(500);
  ok('CONTROL: this fixture DOES raise the popup when the setting is on',
     await ev(`document.getElementById('trip-veh-prompt-modal').classList.contains('open')`) === true);
  await ev(`(function(){
    document.getElementById('trip-veh-prompt-modal').classList.remove('open');
    var s=S(); s.confirmTripsOnFinish=false; DB.set('settings',s);
    setTrips([]); localStorage.removeItem('mcn_tripVehPrompted');
  })()`);
  await sleep(300);

  await finish('tf1');
  await sleep(600);
  ok('NO popup appears when the trip ends',
     (await ev(`document.getElementById('trip-veh-prompt-modal').classList.contains('open')`)) === false);
  ok('…the trip is silently in the log', await ev(`trips().length`) === 1);
  ok('…and durably so', (await ev(`JSON.parse(localStorage.getItem('mcn_trips')).length`)) === 1);
  ok('the Trips tab count appears',
     await ev(`document.getElementById('nav-trips-count').style.display`) === 'block');
  ok('…reading 1', await ev(`document.getElementById('nav-trips-count').textContent`) === '1');
  ok('…and says so for screen readers',
     /1 to review/.test(await ev(`document.getElementById('nav-btn-trips').getAttribute('aria-label')`)));

  await finish('tf2');
  await finish('tf3');
  await sleep(600);
  ok('a second and third trip still raise no popup',
     (await ev(`document.getElementById('trip-veh-prompt-modal').classList.contains('open')`)) === false);
  ok('…and the count follows to 3', await ev(`document.getElementById('nav-trips-count').textContent`) === '3');
  if (process.env.SHOT) {
    const OUT = path.join(__dirname, 'plans', 'v104-shots');
    fs.mkdirSync(OUT, { recursive: true });
    await ev(`(function(){
      var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
      var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
      var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
      tlMonth='2026-07'; tlFilter='all'; tlSel=null; showScreen('trips'); renderTrips();
    })()`);
    await sleep(1200);
    const sh = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, '09-trips-badge.png'), Buffer.from(sh.result.data, 'base64'));
    console.log('  (screenshot written to plans/v104-shots/09-trips-badge.png)');
  }

  // Sorting them out from the Trips tab — the flow he said he prefers.
  await ev(`(function(){ tlMonth='2026-07'; tlFilter='all'; renderTrips(); tlSelectDay('2026-07-22'); })()`);
  await sleep(600);
  ok('all three are waiting in the Trip Log',
     (await ev(`document.querySelectorAll('#tl-sheet-body [data-trip]').length`)) === 3);
  ok('categorising one drops the count to 2', await ev(`(function(){
      tlSetCat('tf1','business'); return document.getElementById('nav-trips-count').textContent; })()`) === '2');
  ok('…and the trip really is business', await ev(`trips().find(function(t){return t.id==='tf1';}).category`) === 'business');
  ok('clearing all three hides the count', await ev(`(function(){
      tlSetCat('tf2','personal'); tlSetCat('tf3','business');
      return document.getElementById('nav-trips-count').style.display; })()`) === 'none');
  ok('…with nothing left pending', await ev(`unreviewedTripCount(trips())`) === 0);

  console.log('\nv104.8 — the escape hatch: turn it back on and the popup returns');
  await ev(`(function(){
    var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
    var s=S(); s.confirmTripsOnFinish=true; DB.set('settings',s);
    localStorage.removeItem('mcn_tripVehPrompted');
  })()`);
  await finish('tf4');
  await sleep(700);
  ok('with the setting ON the popup DOES appear',
     await ev(`document.getElementById('trip-veh-prompt-modal').classList.contains('open')`) === true);
  ok('…asking which vehicle',
     /Which vehicle/.test(await ev(`document.getElementById('trip-veh-prompt-body').innerHTML`)));
  ok('…and it only ever assigns a vehicle, never a category', await ev(`(function(){
      var before=trips().find(function(t){return t.id==='tf4';}).category;
      assignTripVehPrompt('tf4','v1',false);
      var t=trips().find(function(x){return x.id==='tf4';});
      return t.vehicle_id==='v1' && t.category===before; })()`));
  await sleep(500);
  ok('…so it never removed a categorisation path — the count still shows it',
     await ev(`document.getElementById('nav-trips-count').textContent`) === '1');
  await ev(`(function(){
    var s=S(); s.confirmTripsOnFinish=false; DB.set('settings',s);
    document.getElementById('trip-veh-prompt-modal').classList.remove('open');
    localStorage.setItem('mcn_trips',JSON.stringify([])); tlSel=null; renderTrips();
  })()`);
  await sleep(300);

  console.log("v105.2 — Steven's Thursday: worksite travel folded into one row");
  await ev(`(function(){
    localStorage.setItem('mcn_zones',JSON.stringify([]));
    // A real work site, and trips whose polylines fall inside or outside it — so
    // the on-site flags are DERIVED by tlSyncIntraSite exactly as in the field,
    // not hand-set (which the classifier would rightly clear).
    var M=111320, SITE={name:'Lucas Ranch',lat:-28.700,lng:152.000,radius:2900};
    var T0=Date.parse('2026-07-30T08:00:00'), n=0;
    function t(km,cat,onsite){ n++;
      var pts = onsite
        ? [{lat:SITE.lat+(200+n*30)/M,lng:SITE.lng,t:1},{lat:SITE.lat-(150+n*20)/M,lng:SITE.lng,t:2}]
        : [{lat:SITE.lat+(9000+n*500)/M,lng:SITE.lng,t:1},{lat:SITE.lat+(14000+n*500)/M,lng:SITE.lng,t:2}];
      return {id:'t'+n,date:'2026-07-30',category:cat,distance_km:km,
        duration_min:10,start_time:T0+n*600000,end_time:T0+n*600000+600000,polyline:pts}; }
    var trips=[t(40.0,'business'),t(30.0,'business'),t(22.5,'business'),
               t(10.0,'personal'),t(4.7,'unknown'),t(2.0,'unknown')];
    [4.0,3.5,3.4,3.6,3.2,3.2,3.2].forEach(function(k){ trips.push(t(k,'unknown',true)); });
    localStorage.setItem('mcn_trips',JSON.stringify(trips));
    localStorage.setItem('mcn_sites',JSON.stringify([SITE]));
    tlMonth='2026-07'; tlFilter='all'; tlSel=null; _tlOnSiteOpen=null; renderTrips();
  })()`);
  await sleep(700);
  const thuMetrics = await ev(`document.getElementById('tl-metrics').innerHTML`);
  ok('PIN: the month header reads 109 km travel', /<b>109<\/b> km travel/.test(thuMetrics), thuMetrics);
  ok('PIN: …with on-site as a separate footnote', /\+7 on-site/.test(thuMetrics), thuMetrics);
  ok('PIN: …and 85% business, computed on travel only', /<b>85%<\/b> business/.test(thuMetrics), thuMetrics);

  await ev(`tlSelectDay('2026-07-30')`);
  await sleep(600);
  const sub = await ev(`document.getElementById('tl-sheet-sub').textContent`);
  ok('PIN: the day line shows 109.2 km travel', /109\.2 km travel/.test(sub), sub);
  ok('PIN: …92.5 km business', /92\.5 km business/.test(sub), sub);
  ok('PIN: …and +7 on-site (24.1 km) reported apart from it', /\+7 on-site \(24\.1 km\)/.test(sub), sub);
  ok('PIN: the two do not add up to the headline — on-site is excluded',
     !/133/.test(sub), sub);

  console.log('\n  ── PIN: test_on_site_trips_collapse_to_single_summary_row_per_day');
  ok('PIN: 6 travel rows are drawn individually',
     (await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg[data-trip]').length`)) === 6,
     await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg[data-trip]').length`));
  ok('PIN: …plus exactly ONE worksite-travel row, not seven',
     (await ev(`document.querySelectorAll('#tl-sheet-body .tl-onsite-group').length`)) === 1);
  const grp = await ev(`document.querySelector('#tl-sheet-body .tl-onsite-group').textContent`);
  ok('PIN: it is labelled Worksite travel', /Worksite travel/.test(grp), grp);
  ok('PIN: …naming the site', /Lucas Ranch/.test(grp), grp);
  ok('PIN: …with the count and km', /7 trips/.test(grp) && /24\.1 km/.test(grp), grp);
  ok('PIN: …and says plainly it is not counted', /not counted as travel/.test(grp), grp);
  ok('PIN: 7 rows on screen instead of 13',
     (await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg[data-trip], #tl-sheet-body .tl-onsite-group').length`)) === 7);

  console.log('\n  ── PIN: test_tap_expand_on_worksite_summary_shows_individual_trips');
  await ev(`document.querySelector('#tl-sheet-body .tl-onsite-group').click()`);
  await sleep(400);
  ok('PIN: tapping it expands', await ev(`!!document.querySelector('#tl-sheet-body .tl-onsite-group.open')`));
  ok('PIN: …revealing all 7 individually',
     (await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg.is-onsite').length`)) === 7,
     await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg.is-onsite').length`));
  ok('PIN: …each with the reclassify escape hatch',
     (await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg.is-onsite a[onclick*="tlMarkAsTravel"]').length`)) === 7);
  ok('PIN: the travel rows are still there alongside',
     (await ev(`document.querySelectorAll('#tl-sheet-body .tl-seg[data-trip]:not(.is-onsite)').length`)) === 6);
  ok('PIN: tapping again folds it back', await ev(`(function(){
      document.querySelector('#tl-sheet-body .tl-onsite-group').click();
      return document.querySelectorAll('#tl-sheet-body .tl-seg.is-onsite').length===0; })()`));
  ok('PIN: it reopens folded next time the day is opened', await ev(`(function(){
      tlCloseSheet(); tlSelectDay('2026-07-30');
      return _tlOnSiteOpen===null; })()`));
  await sleep(400);

  console.log('\n  ── PIN: test_long_press_on_individual_on_site_trip_shows_edit_delete_reclassify');
  await ev(`(function(){ _tlOnSiteOpen='2026-07-30'; tlRenderSheet(tlDayRow('2026-07-30')); })()`);
  await sleep(300);
  const onsiteId = await ev(`document.querySelector('#tl-sheet-body .tl-seg.is-onsite').getAttribute('data-trip')`);
  await ev(`tlRowActions('${onsiteId}')`);
  await sleep(300);
  ok('PIN: long-press on an on-site trip opens the actions',
     await ev(`document.getElementById('trip-actions-modal').classList.contains('open')`));
  const acts = await ev(`document.getElementById('trip-actions-body').innerHTML`);
  ok('PIN: …offering Reclassify ("Count this as travel") first', /Count this as travel/.test(acts));
  ok('PIN: …Edit', /Edit this trip/.test(acts));
  ok('PIN: …and Delete', /Delete this trip/.test(acts));
  ok('PIN: reclassifying pulls it out of the worksite group', await ev(`(function(){
      closeTripActions(); tlMarkAsTravel('${onsiteId}');
      var t=trips().find(function(x){return x.id==='${onsiteId}';});
      return t.intraSite===false && t.intraSite_manual===true; })()`));
  await sleep(400);
  ok('PIN: …the group drops to 6', await ev(`(function(){
      tlSelectDay('2026-07-30'); tlSelectDay('2026-07-30');
      var g=document.querySelector('#tl-sheet-body .tl-onsite-group');
      return g && /6 trips/.test(g.textContent); })()`));
  ok('PIN: …and that km moves INTO the day total', await ev(`(function(){
      var r=tlDayRow('2026-07-30'); return r.km>109.2 && r.onSiteKm<24.1; })()`));
  ok('a travel row long-press does NOT offer reclassify', await ev(`(function(){
      var id=document.querySelector('#tl-sheet-body .tl-seg[data-trip]:not(.is-onsite)').getAttribute('data-trip');
      tlRowActions(id);
      var h=document.getElementById('trip-actions-body').innerHTML;
      closeTripActions();
      return !/Count this as travel/.test(h) && /Edit this trip/.test(h); })()`));

  if (process.env.SHOT) {
    const OUT = path.join(__dirname, 'plans', 'v104-shots');
    fs.mkdirSync(OUT, { recursive: true });
    await ev(`(function(){
      var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
      var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
      var M=111320, SITE={name:'Lucas Ranch',lat:-28.700,lng:152.000,radius:2900};
      var T0=Date.parse('2026-07-30T08:00:00'), n=0;
      function t(km,cat,onsite){ n++;
        var pts = onsite
          ? [{lat:SITE.lat+(200+n*30)/M,lng:SITE.lng,t:1},{lat:SITE.lat-(150+n*20)/M,lng:SITE.lng,t:2}]
          : [{lat:SITE.lat+(9000+n*500)/M,lng:SITE.lng,t:1},{lat:SITE.lat+(14000+n*500)/M,lng:SITE.lng,t:2}];
        return {id:'t'+n,date:'2026-07-30',category:cat,distance_km:km,
          duration_min:10,start_time:T0+n*600000,end_time:T0+n*600000+600000,polyline:pts}; }
      var trips=[t(40.0,'business'),t(30.0,'business'),t(22.5,'business'),
                 t(10.0,'personal'),t(4.7,'unknown'),t(2.0,'unknown')];
      [4.0,3.5,3.4,3.6,3.2,3.2,3.2].forEach(function(k){ trips.push(t(k,'unknown',true)); });
      DB.set('sites',[SITE]); setTrips(trips);
      tlMonth='2026-07'; tlFilter='all'; _tlOnSiteOpen=null; renderTrips(); tlSelectDay('2026-07-30');
    })()`);
    await sleep(2600);   // let the previous test's toast clear
    // Scroll the sheet so the folded Worksite-travel row is in frame.
    await ev(`(function(){
      var b=document.getElementById('tl-sheet-body');
      var g=document.querySelector('#tl-sheet-body .tl-onsite-group');
      if(g&&b) b.scrollTop = g.offsetTop - 140;
    })()`);
    await sleep(500);
    const sh = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, '10-worksite-travel-folded.png'), Buffer.from(sh.result.data, 'base64'));
    await ev(`tlToggleOnSite('2026-07-30')`);
    await sleep(500);
    await ev(`(function(){ var b=document.getElementById('tl-sheet-body');
      var g=document.querySelector('#tl-sheet-body .tl-onsite-group');
      if(g&&b) b.scrollTop = g.offsetTop - 100; })()`);
    await sleep(400);
    const sh2 = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, '11-worksite-travel-expanded.png'), Buffer.from(sh2.result.data, 'base64'));
    console.log('  (screenshot → plans/v104-shots/10-worksite-travel-folded.png)');
  }
  await ev(`(function(){ setTrips([]); tlSel=null; _tlOnSiteOpen=null; renderTrips(); })()`);
  await sleep(300);

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
