#!/usr/bin/env node
/*
 * test-subactivity-live.js — v103.0 sub-activity tracking + batch costing,
 * driven against the REAL shipped app in a real browser (headless Chrome + CDP).
 *
 * The pure tests prove the logic. These prove the WIRING that pure tests cannot:
 * that a sub-activity zone nested INSIDE a work site records time through the
 * one shared fix sink without disturbing the work timer or the circuit reading;
 * that the batch modal prefills the measured hours and computes $/kg live; that
 * the cost report and its trend render; and that the unified Zones card really
 * manages all four modes from one place.
 *
 * Run:  node test-subactivity-live.js
 *       KEEP=1 node test-subactivity-live.js
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

// The nesting Steven described: a 60 m charcoal shed INSIDE a 2900 m work site,
// plus a circuit pair on the same property. Synthetic coordinates — repo is PUBLIC.
const SEED = `(function(){
  localStorage.setItem('mcn_sites',JSON.stringify([
    {name:'Home block',lat:-28.500,lng:151.900,radius:2900,client:'Muirlawn Pty Ltd'}
  ]));
  localStorage.setItem('mcn_clients',JSON.stringify([{company:'Muirlawn Pty Ltd',isDefault:true}]));
  localStorage.setItem('mcn_zones',JSON.stringify([
    {id:'z-shed',name:'Charcoal shed',mode:'sub_activity',lat:-28.500,lng:151.900,radius:60,
     cost:{hourly_rate:60,output_unit:'kg'}},
    {id:'z-pit', name:'Pit', mode:'circuit-pickup',lat:-28.520,lng:151.900,radius:100},
    {id:'z-tip', name:'Tip', mode:'circuit-dump',  lat:-28.512,lng:151.900,radius:100}
  ]));
  localStorage.setItem('mcn_subsessions',JSON.stringify([]));
  localStorage.setItem('mcn_batches',JSON.stringify([]));
  localStorage.setItem('mcn_circuits',JSON.stringify([]));
  localStorage.setItem('mcn_circuitFixes',JSON.stringify([]));
  localStorage.setItem('mcn_activeSub','null');
  localStorage.setItem('mcn_activeCircuit','null');
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

// A charcoal day: 08:00-13:00 in the shed, then he drives away. Fed one fix at a
// time through the SAME shared sink the GPS watch uses.
const CHARCOAL_DAY = `(function(){
  var M=111320, SHED={lat:-28.500,lng:151.900};
  var T0=new Date(2026,6,30,8,0,0).getTime();
  var f=[];
  for(var t=0;t<=5*3600;t+=300) f.push({lat:SHED.lat+10/M,lng:SHED.lng,t:T0+t*1000});
  f.push({lat:-28.470,lng:151.940,t:T0+5.5*3600*1000});   // drives off — closes it
  window.__SHED_FIXES=f;
  f.forEach(function(x){ circuitOnFix(x.lat,x.lng,10,x.t); });
  return f.length;
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
  const prof = '/tmp/cr-sub-test-' + process.pid;
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
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

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
  ok('three zones loaded', await ev('zones().length') === 3);
  ok('…and one work site, in the separate store that drives the work timer',
     await ev('sites().length') === 1);
  await sleep(400);

  console.log('\nA sub-activity zone NESTED inside a work site');
  // The shed centre is the work-site centre — total nesting. The two must not
  // fight: sites drive the work timer, zones drive the activity system.
  ok('the shed sits inside the work-site fence',
     await ev(`pointInFence(-28.500,151.900,sites()[0],0)`) === true);
  ok('…and inside its own much smaller fence',
     await ev(`pointInFence(-28.500,151.900,{lat:-28.500,lng:151.900,radius:60},0)`) === true);
  ok('the work-site fence is not part of the zone detector',
     await ev(`zoneOfPoint(-28.500,151.900,zones()) && zoneOfPoint(-28.500,151.900,zones()).id`) === 'z-shed');

  console.log('\nDetection through the shared fix sink');
  const n = await ev(CHARCOAL_DAY);
  ok('the day delivered ' + n + ' fixes', n > 50, n);
  ok('one shed session recorded', await ev('subsessions().length') === 1, await ev('subsessions().length'));
  ok('…5 hours of it', await ev('subsessions()[0].duration_s') === 18000, await ev('subsessions()[0].duration_s'));
  ok('…named for the zone', await ev('subsessions()[0].activity') === 'Charcoal shed');
  ok('…filed under the LOCAL date', await ev('subsessions()[0].date') === '2026-07-30');
  ok('…with a stable id derived from the start',
     await ev('subsessions()[0].id') === 's' + new Date(2026, 6, 30, 8, 0, 0).getTime());
  ok('subHoursOn agrees: 5 hours', await ev(`subHoursOn(subsessions(),'z-shed','2026-07-30')`) === 5);

  console.log('\nReplay stays idempotent with two readings running');
  await ev(`window.__SHED_FIXES.forEach(function(f){ circuitOnFix(f.lat,f.lng,10,f.t); });`);
  ok('re-feeding adds no duplicate session', await ev('subsessions().length') === 1);
  await ev(`applyBankedCircuitFixes(window.__SHED_FIXES)`);
  ok('the banked-batch path adds none either', await ev('subsessions().length') === 1);
  ok('…and produced no phantom circuits from a sub-activity zone',
     await ev('circuits().length') === 0, await ev('circuits().length'));

  console.log('\nThe work timer is untouched');
  // The whole premise: the outer work session keeps running as normal.
  ok('no work day was started or stopped by sub-activity detection', await ev('!activeDay()'));
  ok('no day records created', await ev('days().length') === 0);
  ok('no trips created', await ev('trips().length') === 0);
  ok('sub-activity detection does not require a work session to be running',
     await ev('subsessions().length') === 1);

  console.log('\nSub-activities screen');
  // v104.0 retired the Circuits pane (the Loads review screen replaced it), so
  // this screen is sub-activities only and needs no tab switch.
  await ev(`showScreen('circuits')`);
  await sleep(500);
  ok('the Sub-activities screen is showing', await ev(`document.getElementById('screen-circuits').classList.contains('active')`));
  ok('the sub-activity pane is present', await ev(`!!document.getElementById('act-pane-sub')`));
  ok('…and the retired Circuits pane is gone, not just hidden',
     await ev(`!document.getElementById('act-pane-circuits')`));
  ok('…and the tab switcher went with it',
     await ev(`typeof window.actTab`) === 'undefined');
  const list = await ev(`document.getElementById('sub-list-slot').innerHTML`);
  ok('the logged time is listed', /Charcoal shed/.test(list));
  ok('…showing 5 hours', /5h 00m/.test(list), list.slice(0, 400));
  ok('…with a Record batch button', /Record batch/.test(list));

  console.log('\nRecording a batch: 5h + $80 wood -> 120 kg');
  await ev(`openBatchModal('z-shed','2026-07-30')`);
  await sleep(300);
  ok('the modal opens', await ev(`document.getElementById('batch-modal').classList.contains('open')`));
  ok('hours are PREFILLED from what the GPS measured',
     await ev(`+document.getElementById('bm-hours').value`) === 5);
  ok('…the rate comes from the zone’s own config',
     await ev(`+document.getElementById('bm-rate').value`) === 60);
  ok('…and the output field is labelled in the zone’s unit',
     /kg/.test(await ev(`document.getElementById('batch-modal-body').innerHTML`)));
  ok('with no output yet, no cost per unit is invented',
     /—/.test(await ev(`document.getElementById('bm-result').innerHTML`)),
     await ev(`document.getElementById('bm-result').innerHTML`));
  await ev(`(function(){
    document.getElementById('bm-material').value=80;
    document.getElementById('bm-output').value=120;
    bmRecalc();
  })()`);
  const result = await ev(`document.getElementById('bm-result').innerHTML`);
  ok('labour computes live', /\$300\.00/.test(result), result);
  ok('…plus materials into a total', /\$380\.00/.test(result));
  ok('…and $3.17/kg', /\$3\.17\/kg/.test(result));
  await ev(`saveBatch()`);
  await sleep(300);
  ok('the batch is stored', await ev('batches().length') === 1);
  ok('…with the computed cost per unit', await ev('batches()[0].cost_per_unit') === 3.1667);
  ok('…the unit label', await ev('batches()[0].output_unit') === 'kg');
  ok('…and keyed to the zone and day',
     await ev(`batches()[0].zone_id+'|'+batches()[0].date`) === 'z-shed|2026-07-30');
  ok('the modal closed', await ev(`!document.getElementById('batch-modal').classList.contains('open')`));
  ok('the button now reads as done', /Batch ✓/.test(await ev(`document.getElementById('sub-list-slot').innerHTML`)));

  console.log('\nEditing a batch reopens it rather than duplicating');
  await ev(`openBatchModal('z-shed','2026-07-30')`);
  await sleep(200);
  ok('existing values are loaded back', await ev(`+document.getElementById('bm-output').value`) === 120);
  ok('…and the button says Update', /Update batch/.test(await ev(`document.getElementById('batch-modal-body').innerHTML`)));
  await ev(`(function(){document.getElementById('bm-output').value=150;saveBatch();})()`);
  await sleep(200);
  ok('still exactly one batch', await ev('batches().length') === 1);
  ok('…with the corrected output', await ev('batches()[0].output_qty') === 150);
  ok('…and a recalculated cost', await ev('batches()[0].cost_per_unit') === 2.5333, await ev('batches()[0].cost_per_unit'));

  console.log('\nCost report and trend');
  await ev(`(function(){
    var bs=batches();
    bs.push({id:'b0',zone_id:'z-shed',activity:'Charcoal shed',date:'2026-07-20',hours:6,rate:60,
             labour:360,material:100,total:460,output_qty:100,output_unit:'kg',cost_per_unit:4.6,created_at:1});
    DB.set('batches',bs); renderSubActivities();
  })()`);
  await sleep(300);
  const cost = await ev(`document.getElementById('sub-cost-slot').innerHTML`);
  ok('the activity has a cost report', /cost per kg/.test(cost), cost.slice(0, 300));
  ok('…counting both batches', /<b>2<\/b>/.test(cost));
  // $460/100kg and $380/150kg -> $840 over 250 kg = $3.36. Deliberately NOT the
  // mean of 4.60 and 2.53 ($3.57): the bigger batch has to carry more weight.
  ok('…with a weighted overall figure', /\$3\.36/.test(cost), (cost.match(/\$\d+\.\d+/g) || []).join(' '));
  ok('…which is not the mean of the two batch rates', !/\$3\.57/.test(cost));
  ok('…flagging the cheapest batch', /best/.test(cost));
  ok('…and the dearest', /dearest/.test(cost));
  ok('…showing the improvement against the previous batch', /▼/.test(cost));
  ok('…as a percentage', /44\.9%/.test(cost), (cost.match(/[\d.]+%/g) || []).join(' '));

  console.log('\nThe unified Zones card manages all four modes');
  await ev(`showScreen('settings')`);
  await sleep(500);
  const zc = await ev(`document.getElementById('circuit-zones-list').innerHTML`);
  ok('work sites are listed (read from mcn_sites)', /Work sites/.test(zc) && /Home block/.test(zc));
  ok('circuit zones are listed', /Circuit zones/.test(zc) && /Pit/.test(zc) && /Tip/.test(zc));
  ok('sub-activities are listed', /Sub-activities/.test(zc) && /Charcoal shed/.test(zc));
  ok('…showing the configured rate and unit', /\$60\/hr/.test(zc) && /per kg/.test(zc), zc.slice(0, 200));
  ok('a mode selector offers all four', await ev(`
    ['worksite','subactivity','circuitpickup','circuitdump']
      .every(function(k){return !!document.getElementById('cz-mode-'+k);})`));
  ok('cost config shows for a sub-activity',
     await ev(`(function(){czSetMode('sub_activity');return document.getElementById('cz-cost-config').style.display;})()`) === 'block');
  ok('…and hides for a circuit zone',
     await ev(`(function(){czSetMode('circuit-pickup');return document.getElementById('cz-cost-config').style.display;})()`) === 'none');
  ok('…and for a work site',
     await ev(`(function(){czSetMode('worksite');return document.getElementById('cz-cost-config').style.display;})()`) === 'none');

  console.log('\nAdding a work site from the Zones card writes to mcn_sites');
  // It must land where the native geofence registration and the money path read
  // from, not in mcn_zones — otherwise it would look saved but never start a day.
  const fenceCalls = await ev(`(function(){
    window.__fence=0; window.onSitesChanged=function(){window.__fence++;};
    czSetMode('worksite');
    document.getElementById('cz-name').value='Back paddock';
    _czLat=-28.60; _czLng=151.95;
    czSetRadius(800);
    czSave();
    return {sites:sites().length, zones:zones().length, fence:window.__fence};
  })()`);
  ok('the work site went into mcn_sites', fenceCalls.sites === 2, fenceCalls);
  ok('…NOT into mcn_zones', fenceCalls.zones === 3);
  ok('…and the native geofences were re-registered', fenceCalls.fence === 1);
  ok('it appears under Work sites in the list',
     await ev(`(function(){renderZonesCard();return /Back paddock/.test(document.getElementById('circuit-zones-list').innerHTML);})()`));

  console.log('\nAdding a sub-activity zone from the same card');
  ok('a second sub-activity is accepted and configured', await ev(`(function(){
    czSetMode('sub_activity');
    document.getElementById('cz-name').value='Welding bay';
    document.getElementById('cz-rate').value=75;
    document.getElementById('cz-unit').value='joint';
    _czLat=-28.55; _czLng=151.93;
    czSetRadius(50);
    czSave();
    var z=zones().find(function(x){return x.name==='Welding bay';});
    return z && z.mode==='sub_activity' && z.cost.hourly_rate===75 && z.cost.output_unit==='joint';
  })()`) === true);
  ok('a sub-activity zone MAY overlap a work site (that is the point)',
     await ev(`(function(){
       czSetMode('sub_activity');
       document.getElementById('cz-name').value='Inside the block';
       document.getElementById('cz-rate').value=60;
       document.getElementById('cz-unit').value='kg';
       // 1015 m from the work-site centre: well inside the 2900 m fence, and
       // clear of every other activity zone.
       _czLat=-28.508; _czLng=151.905;
       czSetRadius(40);
       var before=zones().length; czSave();
       return zones().length===before+1;
     })()`) === true);
  ok('…but NOT another zone of the activity system', await ev(`(function(){
    var toasts=[]; var ot=window.toast; window.toast=function(m){toasts.push(m);};
    czSetMode('sub_activity');
    document.getElementById('cz-name').value='Clash';
    _czLat=-28.5500; _czLng=151.9300;      // right on top of Welding bay
    czSetRadius(50);
    var before=zones().length; czSave(); window.toast=ot;
    // v104.5: still refused, with a message naming the actual geometry —
    // stacked-on-top is 'too close to the middle', not a partial overlap.
    return zones().length===before && /(overlap|Too close to the middle)/i.test(toasts.join('|'));
  })()`) === true);

  console.log('\nCSV export of batch costs');
  const csv = await ev(`(function(){
    var b=null; var orig=window.shareOrDownload;
    window.shareOrDownload=function(blob,name){ b={name:name}; return Promise.resolve(); };
    exportBatchesCSV(); window.shareOrDownload=orig; return b;
  })()`);
  ok('export produces a CSV', csv && /^batch_costs_\d{4}-\d\d-\d\d\.csv$/.test(csv.name), csv);
  const body = await ev(`(function(){
    var b=null; var orig=window.shareOrDownload;
    window.shareOrDownload=function(blob){ b=blob; return Promise.resolve(); };
    exportBatchesCSV(); window.shareOrDownload=orig;
    return b ? b.text() : null;
  })()`);
  ok('…with an overall line per activity', /overall/.test(body));
  ok('…a row per batch', /Cost per unit/.test(body));
  ok('…carrying the change-vs-previous column', /Change vs previous/.test(body));
  ok('…and the unit label', /"kg"/.test(body));

  console.log('\nRegression: circuits still work alongside');
  ok('the circuit reading is untouched by all of this', await ev(`(function(){
    var M=111320,PIT={lat:-28.520,lng:151.900},TIP={lat:-28.512,lng:151.900};
    var T0=new Date(2026,6,31,7,0,0).getTime();
    var mid={lat:(PIT.lat+TIP.lat)/2,lng:PIT.lng};var f=[];
    function p(z,a,b){for(var t=a;t<=b;t+=30)f.push({lat:z.lat+10/M,lng:z.lng,t:T0+t*1000});}
    function v(a,b){for(var t=a;t<=b;t+=30)f.push({lat:mid.lat,lng:mid.lng,t:T0+t*1000});}
    p(PIT,0,180);v(210,390);p(TIP,420,540);v(570,750);p(PIT,780,960);
    f.forEach(function(x){circuitOnFix(x.lat,x.lng,10,x.t);});
    return circuits().length;
  })()`) === 1);
  ok('…and that circuit is 13 minutes', await ev('circuits()[0].duration_s') === 780);
  // Structural, not a count: the buffer is a rolling 6h window, so fixtures a day
  // apart legitimately evict each other. What must hold is that BOTH readings are
  // driven off that one buffer by one entry point — the "ONE unified system" claim.
  ok('one fix buffer feeds both readings',
     await ev(`/rebuildSubSessions/.test(rebuildCircuits.toString())`));
  ok('…and circuitOnFix is the single writer into it',
     await ev(`/circuitFixes/.test(circuitOnFix.toString()) && /circuitFixes/.test(applyBankedCircuitFixes.toString())`));
  ok('…both reading the same zones list',
     await ev(`/zones\\(\\)/.test(rebuildCircuits.toString()) && /zones\\(\\)/.test(rebuildSubSessions.toString())`));
  ok('subsessions + batches sync; the live cursors do not', await ev(`
    [typeof subsessions, typeof batches, DB.get('activeSub')===null||typeof DB.get('activeSub')==='object'].join(',')`)
    === 'function,function,true');
  ok('no money or day records were touched',
     await ev('days().length') === 0 && await ev('!activeDay()'));
  ok('no uncaught page errors across the whole run', pageErrors.length === 0, pageErrors);

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
  if (!process.env.KEEP) { try { chrome.kill(); } catch (_) {} srv.close(); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e); process.exit(2); });
