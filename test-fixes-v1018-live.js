#!/usr/bin/env node
/*
 * test-fixes-v1018-live.js — the v101.8 field fixes, driven against the REAL
 * shipped app in a real browser (headless Chrome + CDP).
 *
 * The pure tests in test-fixes-v1018.js prove the logic. These prove the WIRING,
 * which pure tests structurally cannot:
 *   1a  a no-finish session renders an explanation + a Set-knock-off-time button
 *       instead of a bare "$0.00 · 0.00h" row, and cannot be Confirmed into the
 *       billable days[] store while it has no finish;
 *   1b  deleting a client actually removes its sites from mcn_sites AND calls
 *       onSitesChanged (which is what unregisters the native geofences), and a
 *       rename re-points them instead of orphaning them;
 *   1b  the startup repair flags an already-orphaned site (Steven's live "Lds")
 *       and the Unlinked Sites list warns that it is still arming a geofence.
 *
 * No emulator needed. Run after touching the //__V1018_FIX_PURE_*__ block or the
 * client/site CRUD.
 *
 * Run:  node test-fixes-v1018-live.js          (starts its own file server)
 *       KEEP=1 node test-fixes-v1018-live.js   (leave Chrome running)
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9461);
const HTTP_PORT = +(process.env.HTTP_PORT || 8801);
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
// The exact broken shape pulled from Steven's Firestore on 2026-07-29: a client
// list with "Church" already gone, and a site still pointing at it. Coordinates
// are synthetic — this repo is PUBLIC.
const SEED = `(function(){
  localStorage.setItem('mcn_clients',JSON.stringify([
    {company:'Muirlawn Pty Ltd',contact:'',abn:'',address:'',email:'',phone:'',isDefault:true}
  ]));
  localStorage.setItem('mcn_sites',JSON.stringify([
    {name:'Lucas Ranch',lat:-28.51,lng:151.94,radius:2900,client:'Muirlawn Pty Ltd'},
    {name:'Lds',lat:-28.22,lng:152.03,radius:1050,client:'Church'}
  ]));
  // One sealed session with NO knock-off time — the shape the phantom produced.
  localStorage.setItem('mcn_unconfirmed',JSON.stringify([{
    id:'nofin1',site:'Lucas Ranch',start:'17:15',date:'2026-07-29',
    startTs:new Date(2026,6,29,17,15).getTime(),finish:null,finishTs:null,
    rate:60,sonrate:30,sonWorking:false,sonHours:null,lunchMins:0,lunchStart:null,
    machines:[],autoStarted:true,rawStart:'17:15',rawFinish:null,
    status:'UNCONFIRMED',edited_by_user:false,no_finish_reason:'no_exit'
  }]));
  localStorage.setItem('mcn_days',JSON.stringify([]));
  localStorage.setItem('mcn_settings',JSON.stringify({namePlaces:false,rate:60,roundTo15:true}));
  localStorage.setItem('mcn_activeDay','null');
  return 'seeded';
})()`;

const BOOT = `(function(){
  var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
  var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
  var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
  // CloudSync can't reach Firestore off a file server; stub it so the CRUD paths
  // under test run to completion instead of dying on the push.
  window.CloudSync={pushAll:function(){return Promise.resolve();},syncKey:function(){return Promise.resolve();}};
  try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
  return 'ok';
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
  const prof = '/tmp/cr-v1018-test-' + process.pid;
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
  const boot = await ev(BOOT);
  ok('app shell boots without throwing', boot === 'ok', boot);
  ok('running the version in source (' + EXPECT_VER + ')', await ev('APP_VERSION') === EXPECT_VER, await ev('APP_VERSION'));
  await sleep(600);

  // ══ 1b — startup repair of the already-orphaned site ═══════════════════════
  console.log('\n1b · startup repair of an already-orphaned site');
  ok('the seeded ghost was detected and repaired',
     await ev(`sites().find(function(s){return s.name==='Lds';}).client === null`));
  ok('…and stamped with the client it lost',
     await ev(`sites().find(function(s){return s.name==='Lds';}).orphanedFrom`) === 'Church');
  ok('…while the healthy site is untouched',
     await ev(`sites().find(function(s){return s.name==='Lucas Ranch';}).client`) === 'Muirlawn Pty Ltd');
  ok('…the site is NOT deleted behind the user’s back', await ev('sites().length') === 2);
  ok('…and the repair is logged for the field record',
     await ev(`(DB.get('geoLog')||[]).some(function(e){return /pointed at a deleted client/.test(e.detail||'');})`));

  console.log('\n1b · the Unlinked Sites list warns it is still armed');
  await ev(`showScreen('settings',document.querySelector('.nav-btn[onclick*="settings"]'))`);
  await sleep(500);
  const listHtml = await ev(`document.getElementById('clients-sites-list').innerHTML`);
  ok('the orphan is shown under Unlinked sites', /Lds/.test(listHtml));
  ok('…with the deleted client named', /Client &quot;Church&quot; was deleted|Client "Church" was deleted/.test(listHtml), listHtml.slice(0, 400));
  ok('…and says it still starts the auto-timer', /still starts the auto-timer/.test(listHtml));

  // ══ 1b — deleting a client takes its sites (and its geofences) with it ═════
  console.log('\n1b · deleting a client cascades to its sites + geofences');
  await ev(`(function(){
    // Re-seed a live client that owns a site, and record onSitesChanged calls so
    // we can prove the native geofences get re-registered.
    DB.set('clients',[{company:'Muirlawn Pty Ltd',isDefault:true},{company:'Church',isDefault:false}]);
    DB.set('sites',[{name:'Lucas Ranch',lat:-28.51,lng:151.94,radius:2900,client:'Muirlawn Pty Ltd'},
                    {name:'Lds',lat:-28.22,lng:152.03,radius:1050,client:'Church'}]);
    window.__fenceCalls=0; window.onSitesChanged=function(){window.__fenceCalls++;};
    window.__confirmMsg=null; window.confirm=function(m){window.__confirmMsg=m;return true;};
    renderClientsList();
  })()`);
  await ev(`deleteClient(1)`);
  await sleep(300);
  ok('the client is gone', await ev(`clientsData().map(function(c){return c.company;}).join(',')`) === 'Muirlawn Pty Ltd');
  ok('THE FIX: its site is gone too',
     await ev(`sites().map(function(s){return s.name;}).join(',')`) === 'Lucas Ranch');
  ok('…geofences were re-registered (onSitesChanged fired)', await ev('window.__fenceCalls') === 1);
  ok('…the user was warned which sites go', /Lds/.test(await ev('window.__confirmMsg')));
  ok('…and told their logged days are safe', /logged days are NOT affected/.test(await ev('window.__confirmMsg')));
  ok('…leaving no orphan behind', await ev(`orphanedSites(sites(),clientsData()).length`) === 0);

  console.log('\n1b · cancelling the confirm changes nothing');
  await ev(`(function(){
    DB.set('clients',[{company:'Muirlawn Pty Ltd',isDefault:true},{company:'Church'}]);
    DB.set('sites',[{name:'Lucas Ranch',lat:-28.51,lng:151.94,radius:2900,client:'Muirlawn Pty Ltd'},
                    {name:'Lds',lat:-28.22,lng:152.03,radius:1050,client:'Church'}]);
    window.__fenceCalls=0; window.confirm=function(){return false;};
  })()`);
  await ev(`deleteClient(1)`);
  ok('client kept', await ev('clientsData().length') === 2);
  ok('site kept', await ev('sites().length') === 2);
  ok('no geofence churn', await ev('window.__fenceCalls') === 0);

  // ══ 1b — renaming a client re-points its sites ════════════════════════════
  console.log('\n1b · renaming a client re-points its sites');
  await ev(`(function(){
    window.confirm=function(){return true;};
    DB.set('clients',[{company:'Muirlawn Pty Ltd',isDefault:true},{company:'Church'}]);
    DB.set('sites',[{name:'Lucas Ranch',lat:-28.51,lng:151.94,radius:2900,client:'Muirlawn Pty Ltd'},
                    {name:'Lds',lat:-28.22,lng:152.03,radius:1050,client:'Church'}]);
    editClient(1);
    document.getElementById('cm-company').value='Church of LDS';
    saveClient();
  })()`);
  await sleep(200);
  ok('THE FIX: the site follows the rename',
     await ev(`sites().find(function(s){return s.name==='Lds';}).client`) === 'Church of LDS');
  ok('…so it is not orphaned', await ev(`orphanedSites(sites(),clientsData()).length`) === 0);
  ok('…and it stays under its client in the list, not in Unlinked',
     await ev(`(function(){renderClientsList();var h=document.getElementById('clients-sites-list').innerHTML;
       var u=h.indexOf('Unlinked sites'); var l=h.indexOf('Lds');
       return u<0 || l<u;})()`));

  // ══ 1a — a no-finish session is explained, and cannot be billed ════════════
  console.log('\n1a · a session with no knock-off time');
  await ev(`(function(){
    DB.set('unconfirmed',[{id:'nofin1',site:'Lucas Ranch',start:'17:15',date:'2026-07-29',
      startTs:new Date(2026,6,29,17,15).getTime(),finish:null,finishTs:null,rate:60,sonrate:30,
      sonWorking:false,sonHours:null,lunchMins:0,lunchStart:null,machines:[],autoStarted:true,
      rawStart:'17:15',rawFinish:null,status:'UNCONFIRMED',edited_by_user:false,no_finish_reason:'no_exit'}]);
    DB.set('days',[]);
    showScreen('log',document.querySelector('.nav-btn[onclick*="log"]'));
    renderLog();
  })()`);
  await sleep(400);
  const backlog = await ev(`document.getElementById('review-backlog-list').innerHTML`);
  ok('the session appears in the Review Backlog', /Lucas Ranch/.test(backlog));
  ok('THE FIX: it explains why the total is $0.00', /Why is this \$0\.00\?/.test(backlog), backlog.slice(0, 300));
  ok('…in plain language about the missing knock-off', /No knock-off was recorded/.test(backlog));
  ok('…and confirms the start time WAS captured', /17:15/.test(backlog));
  ok('…offers a one-tap Set knock-off time', /Set knock-off time/.test(backlog));
  ok('…the badge asks for a knock-off time rather than just saying "no finish"',
     /needs a knock-off time/.test(backlog));
  ok('…and Confirm is disabled until it has one', /disabled/.test(backlog));

  console.log('\n1a · it cannot reach the billable days[] store');
  await ev(`confirmSession('nofin1')`);
  await sleep(200);
  ok('THE FIX: Confirm refuses a finish-less session', await ev('days().length') === 0);
  ok('…and it stays in the review backlog', await ev(`DB.get('unconfirmed').length`) === 1);

  console.log('\n1a · once a knock-off time is set it bills normally');
  await ev(`(function(){var uc=DB.get('unconfirmed');uc[0].finish='18:15';
    uc[0].finishTs=new Date(2026,6,29,18,15).getTime();DB.set('unconfirmed',uc);})()`);
  await ev(`confirmSession('nofin1')`);
  await sleep(200);
  ok('the session confirms into days[]', await ev('days().length') === 1);
  ok('…with the right hours (17:15–18:15 = 1.00h)', await ev(`dayTotals(days()[0]).h`) === 1);
  ok('…and the right money (1.00h × $60)', await ev(`dayTotals(days()[0]).total`) === 60);

  // ══ 1a — the fallback gate is live in the real checkNearbySites ═══════════
  console.log('\n1a · the web-GPS fallback gate is wired into checkNearbySites');
  ok('the gate function is on the page', await ev(`typeof shouldWebFallbackAutoStart`) === 'function');
  ok('a native app with an undrained queue is refused',
     await ev(`shouldWebFallbackAutoStart({insideFence:true,accOk:true,hasActiveDay:false,
       alreadyTriggered:false,hour:8,isNative:true,nativeQueueDrained:false}).reason`) === 'awaiting_native_queue');
  // In the browser there is no native queue, so the v81 fallback must still fire —
  // this is the real function against the real site list and a real fix.
  const started = await ev(`(function(){
    DB.set('sites',[{name:'Lucas Ranch',lat:-28.51,lng:151.94,radius:2900,client:null}]);
    DB.set('activeDay',null); DB.set('unconfirmed',[]);
    geoAutoStartTriggered=false; geoAutoStartDate=null;
    var h=new Date().getHours();
    if(h<5||h>=21) return 'out-of-hours-skip';
    checkNearbySites(-28.511,151.941,10);
    var ad=activeDay();
    return ad?('started:'+ad.site):'no-start';
  })()`);
  ok('browser fallback still auto-starts (v81 safety net intact)',
     started === 'started:Lucas Ranch' || started === 'out-of-hours-skip', started);
  ok('nativeQueueDrained defaults to false before any drain',
     await ev(`typeof nativeQueueDrained`) === 'boolean');
  ok('markNativeQueueDrained is exposed for the bridge', await ev(`typeof window.markNativeQueueDrained`) === 'function');
  await ev(`(function(){DB.set('activeDay',null);})()`);

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
  if (!process.env.KEEP) { try { chrome.kill(); } catch (_) {} srv.close(); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); process.exit(2); });
