#!/usr/bin/env node
/*
 * test-settings-live.js — v105.0 auto-save + collapse persistence, for real.
 *
 * test-settings.js pins the structure. This drives the actual screen: types in
 * fields, flips toggles, collapses cards, reloads the page, and pulls the plug
 * on the network to check an edit survives.
 *
 * Run:  node test-settings-live.js
 *       KEEP=1 node test-settings-live.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = +(process.env.CDP_PORT || 9477);
const HTTP_PORT = +(process.env.HTTP_PORT || 8825);
const WWW = path.join(__dirname, 'www');

function requireWs() {
  const paths = [process.env.WS_NODE_PATH,
    '/usr/local/lib/node_modules/openclaw/node_modules',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules'].filter(Boolean);
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

const BOOT = `(function(){
  var lg=document.getElementById('screen-login'); if(lg) lg.style.display='none';
  var ld=document.getElementById('screen-loading'); if(ld) ld.style.display='none';
  var w=document.getElementById('main-app-wrapper'); if(w) w.style.display='block';
  window.__PUSHES=0; window.__FAILSYNC=false;
  try{ initApp(); }catch(e){ return 'initApp threw: '+e.message; }
  showScreen('settings');
  return 'ok';
})()`;

(async () => {
  const srv = await serve();
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=/tmp/cr-set-' + process.pid, '--window-size=390,844', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

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
  const URL = 'http://127.0.0.1:' + HTTP_PORT + '/index.html';
  const boot = async () => {
    await cmd('Page.navigate', { url: URL + '?cb=' + Date.now() });
    for (let i = 0; i < 100; i++) {
      if (await ev(`typeof initApp==='function' && typeof saveSettings==='function'`)) break;
      await sleep(200);
    }
    const r = await ev(BOOT);
    await sleep(900);
    await installSyncSpy();
    return r;
  };
  // window.CloudSync is assigned by the Firebase module script, which is
  // type="module" and therefore loads asynchronously — a stub installed during
  // boot gets overwritten a moment later, and every push assertion then measures
  // a spy that is no longer there. So: wait for the real one, then wrap it.
  const installSyncSpy = async () => {
    for (let i = 0; i < 40; i++) {
      if (await ev(`typeof window.CloudSync==='object' && !!window.CloudSync`)) break;
      await sleep(100);
    }
    await ev(`(function(){
      window.__PUSHES=0; window.__FAILSYNC=false;
      var real=window.CloudSync||{};
      window.CloudSync={
        pushAll:function(){ window.__PUSHES++;
          return window.__FAILSYNC ? Promise.reject(new Error('offline')) : Promise.resolve(); },
        syncKey:function(){ return Promise.resolve(); },
        fetchTeam:function(){ return Promise.resolve([]); },
        restore:real.restore?real.restore.bind(real):function(){return Promise.resolve();}
      };
      return true;
    })()`);
  };

  console.log('Boot');
  ok('app boots on the Settings screen', await boot() === 'ok');
  ok('the sync spy survived the async Firebase module',
     await ev(`String(window.CloudSync.pushAll).indexOf('__PUSHES')>=0`));
  ok('the Save Settings button is not on the page',
     await ev(`!!Array.prototype.find.call(document.querySelectorAll('#screen-settings button'),function(b){return /Save Settings/.test(b.textContent);})`) === false);

  console.log('\nAuto-save: text field');
  await ev(`window.__PUSHES=0`);
  await ev(`(function(){ var el=document.getElementById('s-name'); el.value='Steven McNichol Earthmoving';
     el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  ok('nothing has saved yet at 100ms', await (async () => { await sleep(100); return await ev(`S().name`); })() !== 'Steven McNichol Earthmoving');
  ok('…the indicator says it is saving', /Saving/.test(await ev(`document.getElementById('settings-save-state').textContent`)));
  await sleep(900);
  ok('after the 600ms debounce it IS saved', await ev(`S().name`) === 'Steven McNichol Earthmoving');
  ok('…and durable in localStorage',
     await ev(`JSON.parse(localStorage.getItem('mcn_settings')).name`) === 'Steven McNichol Earthmoving');
  ok('…and it says Saved ✓', /Saved/.test(await ev(`document.getElementById('settings-save-state').textContent`)));
  await sleep(1800);
  ok('…which then fades', await ev(`document.getElementById('settings-save-state').style.display`) === 'none');

  console.log('\nAuto-save: typing fast only saves once');
  await ev(`window.__PUSHES=0`);
  await ev(`(function(){ var el=document.getElementById('s-abn');
     ['1','12','123','1234','12345'].forEach(function(v){ el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); }); })()`);
  await sleep(1000);
  ok('five keystrokes produce one save', await ev(`window.__PUSHES`) === 1, await ev(`window.__PUSHES`));
  ok('…with the final value', await ev(`S().abn`) === '12345');

  console.log('\nAuto-save: blur is immediate');
  await ev(`window.__PUSHES=0`);
  await ev(`(function(){ var el=document.getElementById('s-address'); el.value='Stanthorpe QLD';
     el.dispatchEvent(new Event('input',{bubbles:true}));
     el.dispatchEvent(new FocusEvent('blur',{bubbles:false})); })()`);
  await sleep(150);
  ok('blur saves without waiting for the debounce', await ev(`S().address`) === 'Stanthorpe QLD');

  console.log('\nAuto-save: a toggle saves on the tap');
  ok('the machine-hire toggle is on the page', await ev(`!!document.getElementById('s-show-machine-hire')`));
  await ev(`window.__PUSHES=0`);
  const before = await ev(`S().showMachineHire===true`);
  await ev(`(function(){ var cb=document.getElementById('s-show-machine-hire');
     cb.checked=!cb.checked; cb.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await sleep(200);
  ok('a toggle is saved immediately, no debounce', await ev(`S().showMachineHire===true`) !== before);
  ok('…and pushed', (await ev(`window.__PUSHES`)) >= 1);

  console.log('\nAuto-save: a number field');
  await ev(`(function(){ var el=document.getElementById('s-rate'); el.value='72';
     el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(900);
  ok('the rate is saved', await ev(`S().rate`) === 72);
  ok('…and the Today screen labels followed', /72/.test(await ev(`document.getElementById('owner-rate-label').textContent`)));

  console.log('\nAuto-save: travel mode (buttons, not a field)');
  await ev(`window.__PUSHES=0; setTravelModeBtn('km');`);
  await sleep(200);
  ok('picking a travel mode saves it', await ev(`S().travelMode`) === 'km');
  ok('…but re-rendering the screen does NOT count as an edit', await ev(`(function(){
      window.__PUSHES=0; loadTravelSettings(); return window.__PUSHES; })()`) === 0);

  console.log('\n── Offline: the edit survives, only the sync retries ────────────');
  await ev(`window.__FAILSYNC=true; window.__PUSHES=0;`);
  await ev(`(function(){ var el=document.getElementById('s-service'); el.value='Earthmoving and haulage';
     el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(900);
  ok('PIN: the edit is written locally even though the push failed',
     await ev(`S().service`) === 'Earthmoving and haulage');
  ok('PIN: …and survives in localStorage',
     await ev(`JSON.parse(localStorage.getItem('mcn_settings')).service`) === 'Earthmoving and haulage');
  ok('PIN: the indicator says it is not synced',
     /Not synced/.test(await ev(`document.getElementById('settings-save-state').textContent`)),
     await ev(`document.getElementById('settings-save-state').textContent`));
  ok('PIN: …and that message does not fade away',
     await ev(`document.getElementById('settings-save-state').style.display`) === 'inline-block');
  const pushesBefore = await ev(`window.__PUSHES`);
  await ev(`window.__FAILSYNC=false`);
  await sleep(1600);
  ok('PIN: it retries on its own once the network is back',
     (await ev(`window.__PUSHES`)) > pushesBefore, { before: pushesBefore, after: await ev(`window.__PUSHES`) });
  ok('PIN: …and then reports Saved ✓',
     /Saved/.test(await ev(`document.getElementById('settings-save-state').textContent`)),
     await ev(`document.getElementById('settings-save-state').textContent`));

  console.log('\n── Collapse state persists across a reload ──────────────────────');
  const state = await ev(`(function(){
    var out={};
    document.querySelectorAll('#screen-settings .card-collapsible').forEach(function(c){
      out[c.dataset.collapseKey]=!c.classList.contains('collapsed'); });
    return out;
  })()`);
  ok('every card is keyed', Object.keys(state).length >= 20 && !Object.keys(state).includes('undefined'),
     Object.keys(state).length);
  ok('the long setup cards start collapsed', state.zones === false && state.tax === false);
  // Open two that were closed, close one that was open.
  await ev(`(function(){
    ['zones','tax'].forEach(function(k){ document.querySelector('[data-collapse-key="'+k+'"] .card-title').click(); });
    document.querySelector('[data-collapse-key="business"] .card-title').click();
  })()`);
  await sleep(300);
  ok('clicking a title opens it', await ev(`!document.querySelector('[data-collapse-key="zones"]').classList.contains('collapsed')`));
  ok('…and clicking an open one closes it', await ev(`document.querySelector('[data-collapse-key="business"]').classList.contains('collapsed')`));
  ok('the choice is stored in the settings blob', await ev(`(function(){
      var st=JSON.parse(localStorage.getItem('mcn_settings')).cardState||{};
      return st.zones==='open' && st.tax==='open' && st.business==='collapsed'; })()`),
     await ev(`JSON.stringify((JSON.parse(localStorage.getItem('mcn_settings')).cardState)||{})`));

  // The real test: reload the whole app.
  ok('PIN: app relaunches', await boot() === 'ok');
  ok('PIN: zones is still open after a relaunch',
     await ev(`!document.querySelector('[data-collapse-key="zones"]').classList.contains('collapsed')`));
  ok('PIN: …tax too', await ev(`!document.querySelector('[data-collapse-key="tax"]').classList.contains('collapsed')`));
  ok('PIN: …and business is still closed',
     await ev(`document.querySelector('[data-collapse-key="business"]').classList.contains('collapsed')`));
  ok('PIN: the earlier field edits also survived the relaunch',
     await ev(`S().name`) === 'Steven McNichol Earthmoving' && await ev(`S().rate`) === 72);
  ok('PIN: card state is inside the synced settings key, not a loose one',
     await ev(`!!JSON.parse(localStorage.getItem('mcn_settings')).cardState`));
  ok('PIN: …so a full backup carries it', await ev(`(function(){
      var got=null; var orig=window.shareOrDownload;
      window.shareOrDownload=function(b){ got=b; return Promise.resolve(); };
      exportFullBackup(); window.shareOrDownload=orig;
      return got ? got.text().then(function(t){ return /cardState/.test(t); }) : false;
    })()`));

  console.log('\n── PIN: Setup Health actually minimises now ─────────────────────');
  ok('PIN: the card is on screen', await ev(`!!document.getElementById('health-card')`));
  ok('PIN: …and is collapsible', await ev(`document.getElementById('health-card').classList.contains('card-collapsible')`));
  // The v105.0 bug in one assertion: the wrapped body must contain the CHECKS,
  // not just the status pill that happens to sit beside the title.
  const bodyHas = await ev(`(function(){
    var b=document.querySelector('#health-card .card-body');
    if(!b) return null;
    return { pillOnly: b.children.length===1 && !!b.querySelector('#health-pill'),
             hasList: !!b.querySelector('#health-check-list'),
             hasSummary: !!b.querySelector('#health-summary'),
             kids: b.children.length };
  })()`);
  ok('PIN: the body wrapped the real content, not just the pill', bodyHas && !bodyHas.pillOnly, bodyHas);
  ok('PIN: …it contains the check list', bodyHas && bodyHas.hasList, bodyHas);
  ok('PIN: …and the summary line', bodyHas && bodyHas.hasSummary, bodyHas);
  const heightOpen = await ev(`document.getElementById('health-card').offsetHeight`);
  await ev(`document.querySelector('#health-card .card-title').click()`);
  await sleep(300);
  ok('PIN: tapping the header collapses it',
     await ev(`document.getElementById('health-card').classList.contains('collapsed')`));
  const heightShut = await ev(`document.getElementById('health-card').offsetHeight`);
  ok('PIN: …and it really shrinks on screen', heightShut < heightOpen / 2, { open: heightOpen, shut: heightShut });
  ok('PIN: …the checks are actually hidden',
     await ev(`document.getElementById('health-check-list').offsetParent === null`));
  ok('PIN: …and the Re-check button too', await ev(`(function(){
      var b=Array.prototype.find.call(document.querySelectorAll('#health-card button'),
        function(x){return /Re-check/.test(x.textContent);});
      return !b || b.offsetParent===null; })()`));
  await ev(`document.querySelector('#health-card .card-title').click()`);
  await sleep(300);
  ok('PIN: tapping again expands it', await ev(`!document.getElementById('health-card').classList.contains('collapsed')`));
  ok('PIN: …back to full height', (await ev(`document.getElementById('health-card').offsetHeight`)) > heightShut * 2);

  console.log('\n── PIN: Setup Health collapse persists across a relaunch ────────');
  await ev(`document.querySelector('#health-card .card-title').click()`);
  await sleep(300);
  ok('collapsed and stored', await ev(`(JSON.parse(localStorage.getItem('mcn_settings')).cardState||{}).health`) === 'collapsed');
  ok('PIN: app relaunches', await boot() === 'ok');
  ok('PIN: Setup Health is STILL collapsed after a relaunch',
     await ev(`document.getElementById('health-card').classList.contains('collapsed')`));
  ok('PIN: …and the body is still correctly wrapped after the rebuild',
     await ev(`!!document.querySelector('#health-card .card-body #health-check-list')`));
  await ev(`document.querySelector('#health-card .card-title').click()`);
  await sleep(200);

  console.log('\n── PIN: an APK older than v104.4 no longer fails silently ───────');
  // Exactly what Steven's phone returns: opened:true, and NO route field —
  // because `route` only exists in the v104.4+ Java.
  await ev(`(function(){
    window.__TOASTS=[]; var _t=window.toast; window.toast=function(m){window.__TOASTS.push(m); return _t(m);};
    window.Capacitor={ isNativePlatform:function(){return true;},
      Plugins:{NativeGeo:{
        getHealthStatus:function(){ return Promise.resolve({fineLocation:'granted',backgroundLocation:'granted',
          batteryExempt:true,playServices:'success',playServicesCode:0,standbyBucket:10,
          manufacturer:'motorola',hasKnownKiller:true,bootReceiver:true,fgsLocationDeclared:true,
          postNotifications:'granted',tripLogging:{enabled:true,running:true}}); },
        openHealthFix:function(o){ return Promise.resolve({target:o&&o.target, opened:true}); }  // pre-v104.4: no route
      }}};
    Health.closeManualSteps();
  })()`);
  await ev(`Health.recheck()`); await sleep(600);
  await ev(`window.__TOASTS=[]`);
  await ev(`Health.fix('manufacturer')`); await sleep(500);
  ok('PIN: the tap is no longer silent', (await ev(`window.__TOASTS.length`)) > 0, await ev(`JSON.stringify(window.__TOASTS)`));
  ok('PIN: …it says the app needs installing',
     /latest app installed/.test(await ev(`JSON.stringify(window.__TOASTS)`)), await ev(`JSON.stringify(window.__TOASTS)`));
  ok('PIN: …and shows the manual steps meanwhile',
     await ev(`document.getElementById('health-steps-modal').classList.contains('open')`));
  ok('PIN: …which are Motorola-specific',
     /Motorola/.test(await ev(`document.getElementById('health-steps-title').textContent`)));
  ok('PIN: …naming the real path', (() => true)() &&
     /Unrestricted/.test(await ev(`document.getElementById('health-steps-body').innerHTML`)));
  ok('PIN: …and it is recorded for off-device diagnosis', await ev(`(function(){
      return (DB.def('geoLog',[])||[]).some(function(e){ return /native returned no route/.test(e.detail||''); }); })()`));
  // A v104.4+ APK reports a route and must NOT get the update nag.
  await ev(`(function(){
    window.Capacitor.Plugins.NativeGeo.openHealthFix=function(o){
      return Promise.resolve({target:o&&o.target, opened:true, route:'app-details'}); };
    window.__TOASTS=[]; Health.closeManualSteps();
  })()`);
  await ev(`Health.fix('manufacturer')`); await sleep(400);
  ok('PIN: a current APK is not nagged to update',
     !/latest app installed/.test(await ev(`JSON.stringify(window.__TOASTS)`)), await ev(`JSON.stringify(window.__TOASTS)`));
  ok('PIN: …it is told where it landed instead',
     /Battery/.test(await ev(`JSON.stringify(window.__TOASTS)`)));
  ok('PIN: …and no steps modal is forced open',
     (await ev(`document.getElementById('health-steps-modal').classList.contains('open')`)) === false);

  console.log('\nA fresh install still gets sensible defaults');
  await ev(`localStorage.removeItem('mcn_settings')`);
  ok('relaunch with no settings at all', await boot() === 'ok');
  ok('the everyday cards are open', await ev(`
     !document.querySelector('[data-collapse-key="rate"]').classList.contains('collapsed')`));
  ok('…and the long ones closed',
     await ev(`document.querySelector('[data-collapse-key="tax"]').classList.contains('collapsed')`));
  ok('nothing threw on a virgin profile', pageErrors.length === 0, pageErrors.slice(0, 3));

  console.log('\nDuplication is gone from the rendered screen');
  ok('only one clear-cache control', await ev(`
     Array.prototype.filter.call(document.querySelectorAll('#screen-settings button'),
       function(b){return /Clear cache/.test(b.textContent);}).length`) === 1);
  ok('only one JSON backup control', await ev(`
     Array.prototype.filter.call(document.querySelectorAll('#screen-settings button,#screen-settings label'),
       function(b){return /backup \\(JSON\\)|Export all data/i.test(b.textContent);}).length`) === 1);
  ok('the restore control sits with it', await ev(`
     !!Array.prototype.find.call(document.querySelectorAll('#screen-settings label'),
       function(l){return /Restore from a JSON backup/.test(l.textContent);})`));
  ok('…inside the Account & Sync card', await ev(`(function(){
      var card=document.querySelector('[data-collapse-key="account"]');
      return !!card && /Restore from a JSON backup/.test(card.textContent) && /Clear cache/.test(card.textContent); })()`));
  ok('no uncaught page errors across the whole run', pageErrors.length === 0, pageErrors.slice(0, 3));

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
  if (!process.env.KEEP) { try { chrome.kill(); } catch (_) {} }
  srv.close();
  try { ws.close(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})();
