#!/usr/bin/env node
/*
 * test-health-battery-fix.js — v104.4 "tap to fix battery killer still not working".
 *
 * THE FIELD EVIDENCE (mirrored Firestore GeoLog, 2026-07-30, Moto Edge 50 Neo):
 *   00:34:06  App started (v104.3)
 *   00:34:36  Health fix requested: manufacturer     ← ×14 between 00:34 and 00:42
 * The tap fired every time, reached native, and Java reported success — so the
 * v104.3 JS correctly stayed quiet. The failure was entirely downstream.
 *
 * ROOT CAUSE: the Motorola branch led with
 * ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS. Android finishes that dialog
 * INSTANTLY with no UI when the app is already exempt — and Steven's is (his
 * battery check passes). startActivity() didn't throw, so tryStart() returned
 * true, so `opened:true`, so nothing was said and nothing was shown. It was also
 * simply the wrong destination: that intent is the `battery` target's job, and
 * this target is meant to reach the manufacturer's own app-kill list.
 *
 * This file pins the JS half of the chain — that a fix request NEVER dead-ends
 * silently, whichever way the native side answers. The Java half (resolve-check
 * before start, honest `opened`, `route` reporting) is verified by inspection
 * plus the emulator; it cannot be exercised from a browser.
 *
 * Run:  node test-health-battery-fix.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9471);
const HTTP_PORT = +(process.env.HTTP_PORT || 8813);
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

// Steven's exact reported state: everything passing EXCEPT the Motorola
// kill-list warning. That is the row whose button did nothing.
const MOTO_RAW = `{
  fineLocation:'granted', backgroundLocation:'granted', batteryExempt:true,
  playServices:'success', playServicesCode:0, standbyBucket:10,
  manufacturer:'motorola', model:'moto edge 50 neo', hasKnownKiller:true,
  bootReceiver:true, fgsLocationDeclared:true, postNotifications:'granted',
  tripLogging:{enabled:true, running:true}
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
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=/tmp/cr-batt-' + process.pid,
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

  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cmd('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/index.html' });
  // Poll for readiness rather than guessing a sleep — the page pulls Leaflet and
  // the Firebase modules from CDNs, so a fixed wait is a flaky test.
  for (let i = 0; i < 100; i++) {
    if (await ev(`typeof initApp === 'function' && typeof Health === 'object'`)) break;
    await sleep(200);
  }

  // `__ROUTE` is what the (stubbed) native chain reports back. Setting it to
  // null models "nothing on this device handled the intent".
  const boot = await ev(`(function(){
    window.__FIX=[]; window.__TOASTS=[]; window.__ROUTE='app-details'; window.__OPENED=true;
    window.Capacitor={
      isNativePlatform:function(){return true;},
      Plugins:{NativeGeo:{
        getHealthStatus:function(){ return Promise.resolve(${MOTO_RAW}); },
        getTripLoggingStatus:function(){ return Promise.resolve({enabled:true, running:true}); },
        openHealthFix:function(o){
          window.__FIX.push(o&&o.target);
          return Promise.resolve({ target:(o&&o.target), opened:window.__OPENED,
                                   route:window.__ROUTE, manufacturer:'motorola' });
        }
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

  console.log('Boot — Steven\'s exact reported state');
  ok('app shell boots', boot === 'ok', boot);
  await ev(`showScreen('settings')`);
  await sleep(1200);
  console.log('   rows:', await ev(`(function(){ return (Health._lastChecks||[]).map(function(c){return c.id+'='+c.status;}).join(' '); })()`));
  ok('9 of 10 checks passing, as on his screenshot',
     /9 of 10/.test(await ev(`document.getElementById('health-summary').textContent`)),
     await ev(`document.getElementById('health-summary').textContent`));
  const mfrRow = await ev(`(function(){
      var rows=[].slice.call(document.querySelectorAll('#health-check-list .hc-row'));
      var r=rows.filter(function(x){return /battery killer/i.test(x.textContent);})[0];
      return r?r.outerHTML:''; })()`);
  ok('the "Manufacturer battery killer" row is the one warning', /hc-warn/.test(mfrRow), mfrRow.slice(0, 160));
  ok('…and it renders a Tap-to-fix button (never was a rendering bug)', /Tap to fix/.test(mfrRow));

  console.log('\n── PIN: test_health_battery_fix_never_dead_ends ──────────────');
  // 1. A Moto-specific page resolved.
  await ev(`window.__FIX=[]; window.__TOASTS=[]; window.__OPENED=true; window.__ROUTE='com.motorola.appmanager';`);
  await ev(`Health.fix('manufacturer')`); await sleep(400);
  ok('PIN: the manufacturer fix reaches native', (await ev(`window.__FIX.length`)) === 1);
  ok('PIN: …with the manufacturer target', await ev(`window.__FIX[0]`) === 'manufacturer');
  ok('PIN: a resolved Moto page is logged with its route', await ev(`(function(){
      return (DB.def('geoLog',[])||[]).some(function(e){ return /Health fix opened: manufacturer → com.motorola.appmanager/.test(e.detail||''); }); })()`));

  // 2. Nothing Moto-specific resolved → the app page. This is what actually
  //    happens on the Edge 50 Neo, where no separate autostart manager exists.
  await ev(`window.__TOASTS=[]; window.__ROUTE='app-details'; window.__OPENED=true;`);
  await ev(`Health.fix('manufacturer')`); await sleep(400);
  ok('PIN: falling back to the app page still counts as opened',
     (await ev(`window.__TOASTS.length`)) > 0, await ev(`JSON.stringify(window.__TOASTS)`));
  ok('PIN: …and the user is told the setting is one more tap down',
     /Battery/.test(await ev(`JSON.stringify(window.__TOASTS)`)) &&
     /Unrestricted/.test(await ev(`JSON.stringify(window.__TOASTS)`)),
     await ev(`JSON.stringify(window.__TOASTS)`));

  // 3. THE REPORTED BUG: nothing on the device handled it.
  await ev(`window.__TOASTS=[]; window.__OPENED=false; window.__ROUTE='none';
            Health.closeManualSteps();`);
  await ev(`Health.fix('manufacturer')`); await sleep(500);
  ok('PIN: a dead-end NEVER passes silently — it toasts',
     (await ev(`window.__TOASTS.length`)) > 0, await ev(`JSON.stringify(window.__TOASTS)`));
  ok('PIN: …and opens the manual steps automatically',
     await ev(`document.getElementById('health-steps-modal').classList.contains('open')`));
  const steps = await ev(`document.getElementById('health-steps-body').innerHTML`);
  ok('PIN: …which are Motorola-specific', /Motorola/.test(await ev(`document.getElementById('health-steps-title').textContent`)),
     await ev(`document.getElementById('health-steps-title').textContent`));
  ok('PIN: …naming the real path (Apps → this app → Battery → Unrestricted)',
     /Apps/.test(steps) && /Battery/.test(steps) && /Unrestricted/.test(steps), steps.slice(0, 400));
  ok('PIN: …and saying WHY there is no autostart list on this phone',
     /no separate autostart/i.test(steps));
  ok('PIN: …with a re-check button to close the loop', /Health.recheck\(\)/.test(steps));
  ok('PIN: the dead-end is recorded for off-device diagnosis', await ev(`(function(){
      return (DB.def('geoLog',[])||[]).some(function(e){ return /found no page for: manufacturer/.test(e.detail||''); }); })()`));
  await ev(`Health.closeManualSteps()`);

  // 4. Every fix row offers the steps WITHOUT having to fail first.
  console.log('\nThe escape hatch is always present, not only after a failure');
  await ev(`window.__OPENED=true; window.__ROUTE='app-details'; Health.recheck();`); await sleep(500);
  const links = await ev(`document.querySelectorAll('#health-check-list .hc-manual a').length`);
  const btns  = await ev(`document.querySelectorAll('#health-check-list .hc-fix').length`);
  ok('every fix button has a "See the steps" link beside it', links === btns && links > 0, { links, btns });
  ok('tapping the link opens the steps without any fix attempt', await ev(`(function(){
      window.__FIX=[]; document.querySelector('#health-check-list .hc-manual a').click();
      return document.getElementById('health-steps-modal').classList.contains('open') && window.__FIX.length===0; })()`));
  await ev(`Health.closeManualSteps()`);

  console.log('\nManual steps are written per manufacturer and per target');
  const stepsFor = async (mfr, target) => ev(`(function(){
      Health._lastRaw={manufacturer:'${mfr}'};
      var m=Health._manualSteps('${target}');
      return JSON.stringify({title:m.title, steps:m.steps.join(' | ')}); })()`);
  ok('Motorola → Unrestricted, and says the autostart list does not exist',
     /Motorola/.test(await stepsFor('motorola','manufacturer')) &&
     /Unrestricted/.test(await stepsFor('motorola','manufacturer')));
  ok('Samsung → sleeping apps', /Sleeping apps/.test(await stepsFor('samsung','manufacturer')));
  ok('Xiaomi → Autostart', /Autostart/.test(await stepsFor('xiaomi','manufacturer')));
  ok('an unknown brand still gets usable generic steps',
     /Apps/.test(await stepsFor('nothing','manufacturer')) &&
     /Unrestricted/.test(await stepsFor('nothing','manufacturer')));
  ok('location has its own steps naming "Allow all the time"',
     /Allow all the time/.test(await stepsFor('motorola','location')));
  ok('…and precise location', /precise/i.test(await stepsFor('motorola','location')));
  ok('play services steps point at the Play Store',
     /Play Store/.test(await stepsFor('motorola','playservices')));
  ok('an unrecognised target still returns usable steps, never empty',
     (await ev(`Health._manualSteps('nonsense').steps.length`)) > 0);
  ok('no manufacturer known at all does not throw',
     (await ev(`(function(){ Health._lastRaw=null; return Health._manualSteps('battery').steps.length; })()`)) > 0);

  console.log('\nThe other failure modes still hold (v104.3 regressions)');
  await ev(`window.Capacitor.Plugins.NativeGeo.openHealthFix=function(){ return Promise.reject(new Error('boom')); };
            window.__TOASTS=[];`);
  await ev(`Health.fix('manufacturer')`); await sleep(300);
  ok('a rejected fix still toasts', (await ev(`window.__TOASTS.length`)) > 0);
  await ev(`delete window.Capacitor.Plugins.NativeGeo.openHealthFix; window.__TOASTS=[];`);
  await ev(`Health.fix('manufacturer')`); await sleep(300);
  ok('no fix bridge at all still tells the user where to go',
     /phone Settings/.test(await ev(`JSON.stringify(window.__TOASTS)`)));
  ok('the return-from-settings re-check is still armed before the call',
     await ev(`Health._pendingRefresh`) === true);
  ok('no uncaught page errors across the whole run', pageErrors.length === 0, pageErrors.slice(0, 3));

  // SHOT=1 captures the two screens for the ship report.
  if (process.env.SHOT) {
    const OUT = path.join(__dirname, 'plans', 'v104-shots');
    fs.mkdirSync(OUT, { recursive: true });
    // Firebase auth settles to signed-out mid-run and re-shows the login overlay,
    // which the DOM assertions don't care about but a screenshot certainly does.
    await ev(`(function(){
      var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
      var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
      var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
      showScreen('settings');
    })()`);
    await sleep(400);
    await ev(`Health.closeManualSteps(); window.__OPENED=true; window.__ROUTE='app-details'; Health.recheck();`);
    await sleep(700);
    await ev(`document.getElementById('health-card').scrollIntoView({block:'start'})`);
    await sleep(500);
    let sh = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, '07-health-card.png'), Buffer.from(sh.result.data, 'base64'));
    await ev(`Health.showManualSteps('manufacturer')`);
    await sleep(700);
    sh = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, '08-manual-steps.png'), Buffer.from(sh.result.data, 'base64'));
    console.log('  (screenshots written to plans/v104-shots/)');
  }

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
  if (!process.env.KEEP) { try { chrome.kill(); } catch (_) {} }
  srv.close();
  try { ws.close(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
