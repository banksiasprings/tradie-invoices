#!/usr/bin/env node
/*
 * test-health-live.js — v104.3 Setup Health: the buttons actually do something.
 *
 * Steven, on v103.0: "health check is not working correctly clicking tap to fix
 * and refresh both do nothing."
 *
 * The handlers were wired correctly all along — this is NOT a binding bug. It is
 * three separate states in which the card is genuinely dead to the touch, none of
 * which gave the user any feedback:
 *
 *   A. bridge missing (JS newer than the APK) → every check is 'na', 'na' never
 *      qualifies for a fix button, so ZERO buttons rendered.
 *   B. getHealthStatus never resolves → the awaited refresh hung forever.
 *   C. openHealthFix never resolves → silent no-op, no toast.
 *
 * B and C are the live risk on Steven's phone specifically: the Moto Edge 50 Neo
 * destroys MainActivity the instant the app is backgrounded (the v101.6 finding),
 * and openHealthFix backgrounds it BY DESIGN — launching the Settings app is its
 * whole job. A PluginCall whose bridge is torn down never settles.
 *
 * Runs the REAL shipped Health module against a stubbed Capacitor bridge, and
 * CLICKS the real buttons. No emulator, no device.
 *
 * Run:  node test-health-live.js
 *       KEEP=1 node test-health-live.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9469);
const HTTP_PORT = +(process.env.HTTP_PORT || 8809);
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

// A healthy-but-imperfect phone: exactly the shape Steven's Moto reports.
const HEALTHY_RAW = `{
  fineLocation:'granted', backgroundLocation:'denied', batteryExempt:false,
  playServices:'success', playServicesCode:0, standbyBucket:40,
  manufacturer:'motorola', model:'edge 50 neo', hasKnownKiller:true,
  bootReceiverEnabled:true, fgsLocationDeclared:true, postNotifications:'granted'
}`;

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
  const prof = '/tmp/cr-health-test-' + process.pid;
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + prof,
    '--window-size=390,844', '--hide-scrollbars', '--no-first-run',
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
  let mid = 0; const pend = new Map(); const pageErrors = [];
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
  // Fire-and-forget: never let CDP await the promise, or a deliberate hang in a
  // fixture would hang the harness instead of the code under test.
  const evNoWait = expr => cmd('Runtime.evaluate', { expression: '(function(){' + expr + '})(), 0', returnByValue: true });

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const URL = 'http://127.0.0.1:' + HTTP_PORT + '/index.html';
  await cmd('Page.navigate', { url: URL });
  await sleep(2000);

  // Boot with a native bridge that behaves like the real APK, and spies on both
  // the plugin calls and the toasts.
  const boot = await ev(`(function(){
    window.__FIX=[]; window.__TOASTS=[];
    window.Capacitor={
      isNativePlatform:function(){return true;},
      Plugins:{NativeGeo:{
        getHealthStatus:function(){ return Promise.resolve(${HEALTHY_RAW}); },
        getTripLoggingStatus:function(){ return Promise.resolve({serviceRunning:true}); },
        openHealthFix:function(o){ window.__FIX.push(o&&o.target); return Promise.resolve({opened:true,target:o&&o.target}); }
      }}
    };
    var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
    var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
    var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
    window.CloudSync={pushAll:function(){return Promise.resolve();},syncKey:function(){return Promise.resolve();},fetchTeam:function(){return Promise.resolve([]);}};
    try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
    var _t=window.toast; window.toast=function(m){ window.__TOASTS.push(m); return _t(m); };
    return 'ok';
  })()`);

  const EXPECT_VER = (fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')
    .match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1];

  console.log('Boot');
  ok('app shell boots', boot === 'ok', boot);
  ok('running the version in source (' + EXPECT_VER + ')', await ev('APP_VERSION') === EXPECT_VER);
  ok('Health is reachable the way an inline onclick reaches it',
     await ev(`typeof Health`) === 'object' && await ev(`Health===window.Health`));

  await ev(`showScreen('settings')`);
  await sleep(1200);

  console.log('\n── PIN: test_health_check_tap_to_fix_and_refresh_execute_handlers ──');
  ok('PIN: the Health card is on the Settings screen', await ev(`!!document.getElementById('health-card')`));
  const nFix = await ev(`document.querySelectorAll('#health-check-list .hc-fix').length`);
  ok('PIN: tap-to-fix buttons are rendered for the failing checks', nFix > 0, nFix);
  ok('PIN: the Re-check button exists', await ev(`(function(){
      return [].slice.call(document.querySelectorAll('#health-card button'))
        .some(function(b){return /Re-check/.test(b.textContent);}); })()`));

  // TAP TO FIX — a real click, reaching the real native bridge.
  await ev(`window.__FIX=[]; window.__TOASTS=[];`);
  await ev(`document.querySelector('#health-check-list .hc-fix').click()`);
  await sleep(700);
  ok('PIN: clicking "Tap to fix" reaches the native bridge',
     (await ev(`window.__FIX.length`)) === 1, await ev(`JSON.stringify(window.__FIX)`));
  ok('PIN: …passing the check\'s fix target',
     typeof (await ev(`window.__FIX[0]`)) === 'string' && (await ev(`window.__FIX[0]`)).length > 0,
     await ev(`window.__FIX[0]`));
  ok('PIN: …and arms the return-from-settings re-check', await ev(`Health._pendingRefresh`) === true);

  // RE-CHECK — a real click, and it must visibly acknowledge the tap.
  await ev(`window.__TOASTS=[]; window.__RAN=0;
            var _r=Health.run.bind(Health); Health.run=function(){window.__RAN++; return _r();};
            document.getElementById('health-stamp').textContent='';`);
  await ev(`(function(){ [].slice.call(document.querySelectorAll('#health-card button'))
      .filter(function(b){return /Re-check/.test(b.textContent);})[0].click(); })()`);
  await sleep(900);
  ok('PIN: clicking "Re-check" actually runs the checks', await ev(`window.__RAN`) === 1, await ev(`window.__RAN`));
  ok('PIN: …and says so, so it can never look like a dead button',
     (await ev(`window.__TOASTS.length`)) > 0, await ev(`JSON.stringify(window.__TOASTS)`));
  ok('PIN: …and stamps when it last checked',
     /Last checked \d\d:\d\d:\d\d/.test(await ev(`document.getElementById('health-stamp').textContent`)),
     await ev(`document.getElementById('health-stamp').textContent`));

  console.log('\nA — bridge missing (JS newer than the installed APK)');
  await ev(`delete window.Capacitor.Plugins.NativeGeo.getHealthStatus; window.__TOASTS=[];`);
  await ev(`Health.recheck()`);
  await sleep(500);
  ok('the card reports it cannot check', /Cannot check/.test(await ev(`document.getElementById('health-pill').textContent`)));
  // The reported bug: this state used to render ZERO buttons.
  ok('it still offers something to tap — the card is not dead',
     (await ev(`document.querySelectorAll('#health-check-list .hc-fix').length`)) > 0,
     await ev(`document.querySelectorAll('#health-check-list .hc-fix').length`));
  ok('…and that button reaches the bridge', await ev(`(function(){
      window.__FIX=[]; document.querySelector('#health-check-list .hc-fix').click();
      return window.__FIX.length; })()`) === 1);
  ok('re-check in this state still acknowledges the tap',
     (await ev(`window.__TOASTS.length`)) > 0, await ev(`JSON.stringify(window.__TOASTS)`));
  ok('…and tells the user to update the app', /latest app/.test(await ev(`JSON.stringify(window.__TOASTS)`)));

  console.log('\nB — getHealthStatus never resolves (bridge torn down mid-call)');
  await ev(`window.Capacitor.Plugins.NativeGeo.getHealthStatus=function(){ return new Promise(function(){}); };
            window.__TOASTS=[]; window.__STATE='pending';`);
  await evNoWait(`Health.recheck().then(function(){ window.__STATE='done'; });`);
  await sleep(2000);
  ok('the card shows it is working, not frozen silently',
     /Checking/.test(await ev(`document.getElementById('health-summary').textContent`)),
     await ev(`document.getElementById('health-summary').textContent`));
  ok('…still pending at 2s (the deadline is 6s, not instant)', await ev(`window.__STATE`) === 'pending');
  await sleep(6000);
  ok('…but it COMPLETES rather than hanging forever', await ev(`window.__STATE`) === 'done');
  ok('…and tells the user the app did not answer',
     /didn.t answer/.test(await ev(`JSON.stringify(window.__TOASTS)`)), await ev(`JSON.stringify(window.__TOASTS)`));
  ok('…with recovery advice on the card',
     /reopen/i.test(await ev(`document.getElementById('health-check-list').innerHTML`)));

  console.log('\nC — openHealthFix never resolves (Settings intent backgrounds us)');
  await ev(`window.Capacitor.Plugins.NativeGeo.getHealthStatus=function(){ return Promise.resolve(${HEALTHY_RAW}); };`);
  await ev(`Health.recheck()`); await sleep(600);
  await ev(`window.Capacitor.Plugins.NativeGeo.openHealthFix=function(){ return new Promise(function(){}); };
            window.__TOASTS=[]; Health._pendingRefresh=false;`);
  await evNoWait(`document.querySelector('#health-check-list .hc-fix').click();`);
  await sleep(600);
  ok('the return-from-settings re-check is armed BEFORE the call, not after',
     await ev(`Health._pendingRefresh`) === true);
  await sleep(4500);
  ok('a hung fix still tells the user something happened',
     (await ev(`window.__TOASTS.length`)) > 0, await ev(`JSON.stringify(window.__TOASTS)`));

  console.log('\nOther failure modes still handled');
  await ev(`window.Capacitor.Plugins.NativeGeo.openHealthFix=function(){ return Promise.reject(new Error('boom')); };
            window.__TOASTS=[];`);
  await ev(`Health.fix('battery')`);
  await sleep(300);
  ok('a rejected fix toasts rather than failing silently',
     /manually/.test(await ev(`JSON.stringify(window.__TOASTS)`)), await ev(`JSON.stringify(window.__TOASTS)`));
  await ev(`window.Capacitor.Plugins.NativeGeo.openHealthFix=function(){ return Promise.resolve({opened:false}); };
            window.__TOASTS=[];`);
  await ev(`Health.fix('manufacturer')`);
  await sleep(300);
  // v104.4: a dead-end no longer just apologises — it shows the manual steps.
  ok('a fix the OS refused to open says so',
     /no page for that/.test(await ev(`JSON.stringify(window.__TOASTS)`)), await ev(`JSON.stringify(window.__TOASTS)`));
  ok('…and opens the manual steps rather than leaving the user stuck',
     await ev(`document.getElementById('health-steps-modal').classList.contains('open')`));
  await ev(`Health.closeManualSteps()`);
  await ev(`delete window.Capacitor.Plugins.NativeGeo.openHealthFix; window.__TOASTS=[];`);
  await ev(`Health.fix('location')`);
  await sleep(300);
  ok('with no fix bridge at all it tells the user where to go by hand',
     /phone Settings/.test(await ev(`JSON.stringify(window.__TOASTS)`)), await ev(`JSON.stringify(window.__TOASTS)`));
  await ev(`window.Capacitor.Plugins.NativeGeo.openHealthFix=function(o){ window.__FIX.push(o&&o.target); return Promise.resolve({opened:true}); };`);
  await ev(`window.__TOASTS=[]; var _run=Health.run.bind(Health); Health.run=function(){ throw new Error('kaboom'); };`);
  await ev(`Health.recheck()`); await sleep(400);
  ok('a throwing check run recovers instead of leaving "Checking…" forever',
     !/Checking…$/.test(await ev(`document.getElementById('health-summary').textContent`)),
     await ev(`document.getElementById('health-summary').textContent`));
  ok('…and says so', (await ev(`window.__TOASTS.length`)) > 0, await ev(`JSON.stringify(window.__TOASTS)`));

  console.log('\nRegression: the gate and the rest of the app are untouched');
  await ev(`Health.run=function(){ return Promise.resolve({checks:[],native:false,raw:null,bridgeUnavailable:false,
      criticalFails:[],warnings:[],allCriticalPass:true}); };`);
  ok('the Start-Shift gate still fails OPEN (it must never trap the user)',
     await ev(`Health.gateStartShift()`) === true);
  ok('silent refresh (screen open / resume) does not toast', await ev(`(function(){
      window.__TOASTS=[]; return Health.refresh().then(function(){ return window.__TOASTS.length; }); })()`) === 0);
  ok('no uncaught page errors across the whole run', pageErrors.length === 0, pageErrors.slice(0, 3));

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
  if (!process.env.KEEP) { try { chrome.kill(); } catch (_) {} }
  srv.close();
  try { ws.close(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
