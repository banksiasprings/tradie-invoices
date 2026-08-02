#!/usr/bin/env node
/*
 * test-widget-bridge.js — v107.0, the one test that proves the native round-trip.
 *
 * test-widget.js pins the snapshot's shape and wording; WidgetRenderTest proves
 * the layouts inflate. Neither exercises the BRIDGE: that the app can actually
 * hand a snapshot to Java, that it lands in SharedPreferences, and that the
 * DB.set hook fires without anyone calling it by hand. This does, on a device.
 *
 * Needs a booted emulator (or phone) with the v107.0 APK installed and the app
 * in the foreground. Set it up with:
 *
 *   npx cap sync android                     # ← the APK bundles www/; a stale
 *   cd android && ./gradlew :app:assembleDebug   #   sync is why this test first
 *   adb install -r build/android/app/outputs/apk/debug/app-debug.apk
 *   adb shell am start -n com.banksiasprings.invoices/.MainActivity
 *   PID=$(adb shell ps -A | grep banksia | awk '{print $2}' | head -1)
 *   adb forward tcp:9333 localabstract:webview_devtools_remote_$PID
 *   node test-widget-bridge.js
 *
 * NOTE: it needs no sign-in — the plugin call and the DB.set hook are both below
 * the auth layer, which is the point of keeping the widget off Firestore.
 *
 * WARNING: this WRITES to the device's mcn_days and mcn_settings. Run it on the
 * emulator, never against Steven's phone.
 */
const http = require('http'), path = require('path');
function requireWs(){ const p=[process.env.WS_NODE_PATH,'/usr/local/lib/node_modules/openclaw/node_modules','/opt/homebrew/lib/node_modules/openclaw/node_modules'].filter(Boolean);
  try{return require('ws')}catch(_){} for(const q of p){try{return require(path.join(q,'ws'))}catch(_){}} throw new Error('need ws'); }
const WS=requireWs();
const get=p=>new Promise((res,rej)=>http.get({host:'127.0.0.1',port:9333,path:p},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej));
(async()=>{
  const tabs=await get('/json/list'); const page=tabs.find(t=>t.type==='page')||tabs[0];
  const ws=new WS(page.webSocketDebuggerUrl,{perMessageDeflate:false});
  await new Promise(r=>ws.on('open',r));
  let id=0; const pend=new Map();
  ws.on('message',m=>{const j=JSON.parse(m); if(j.id&&pend.has(j.id)){pend.get(j.id)(j);pend.delete(j.id);}});
  const ev=async e=>{const i=++id; const p=new Promise(r=>pend.set(i,r));
    ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:e,awaitPromise:true,returnByValue:true}}));
    const r=await p; if(r.result&&r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result&&r.result.result&&r.result.result.value; };
  let f=0,pass=0; const ok=(n,c,x)=>{ if(c){pass++;console.log('  ✓ '+n);} else {f++;console.log('  ✗ '+n+(x!==undefined?'  → '+JSON.stringify(x):''));} };

  console.log('── v107.0 widget bridge, on the emulator ──────────────────────');
  ok('app is v107.0', await ev('APP_VERSION')==='v107.0', await ev('APP_VERSION'));
  ok('running natively', await ev('!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform())'));
  ok('the StatsWidget plugin is on the bridge', await ev('!!(window.Capacitor.Plugins.StatsWidget)'));
  ok('…exposing updateSnapshot', await ev('typeof window.Capacitor.Plugins.StatsWidget.updateSnapshot')==='function');
  ok('…and consumePendingScreen', await ev('typeof window.Capacitor.Plugins.StatsWidget.consumePendingScreen')==='function');

  // Seed his real FY shape, then let the SHIPPED DB.set hook do the push.
  await ev(`(function(){var mk=function(d,st,fi){return{id:'w'+d,date:d,site:'Lucas Ranch',start:st,finish:fi,lunchMins:0,rate:60,sonWorking:false,machines:[],travelMode:'none',materials:[]}};
    var D=[mk('2026-07-01','07:00','12:45'),mk('2026-07-02','07:00','12:00'),mk('2026-07-03','07:00','12:00'),
           mk('2026-07-06','07:00','13:00'),mk('2026-07-07','07:00','12:30'),mk('2026-07-08','07:00','13:00'),
           mk('2026-07-27','07:00','13:30'),mk('2026-07-28','07:00','13:30'),mk('2026-07-29','07:00','13:30'),
           mk('2026-07-30','07:00','13:30'),mk('2026-07-31','07:00','13:17')];
    var s=S(); s.rate=60; s.annualEarningsGoal=140400; s.weeklyHrsGoal=45; delete s.retention; DB.set('settings',s);
    DB.set('days',D); return D.length;})()`);
  await new Promise(r=>setTimeout(r,1500));   // the push is debounced 400ms

  const raw = await ev(`window.Capacitor.Plugins.StatsWidget.getSnapshot().then(function(r){return r.json})`);
  ok('PIN: a snapshot reached SharedPreferences via the plugin', !!raw, raw && raw.slice(0,40));
  const snap = raw ? JSON.parse(raw) : {};
  ok('PIN: …carrying his real retained total', snap.retained===3932, snap.retained);
  ok('…his target', snap.target===140400, snap.target);
  ok('…the unsoftened verdict', /^Behind by \$8,\d\d\d on a straight-line target\.$/.test(snap.gapText||''), snap.gapText);
  ok('PIN: …and never "on track"/"on pace"/"caught up"',
     !/on track|on pace|caught up/i.test((snap.gapText||'')+' '+(snap.paceNote||'')));
  ok('…the pace basis', /3 of 5 weeks had hours/.test(snap.paceNote||''), snap.paceNote);
  ok('…effective rate is HIS rate', snap.effectiveRate===60, snap.effectiveRate);
  ok('…three Monday-keyed week buckets', (snap.weeks||[]).length===3 && snap.weeks[0].k==='2026-06-29', snap.weeks);
  ok('…and the weekly goal from settings, not hard-coded', snap.weekGoalHours===45, snap.weekGoalHours);

  // The whole point of the DB.set hook: a save the developer never wired by hand.
  await ev(`(function(){var s=S(); s.annualEarningsGoal=90000; DB.set('settings',s);})()`);
  await new Promise(r=>setTimeout(r,1500));
  const raw2 = await ev(`window.Capacitor.Plugins.StatsWidget.getSnapshot().then(function(r){return r.json})`);
  ok('PIN: a settings save refreshes the snapshot with no explicit call',
     JSON.parse(raw2||'{}').target===90000, JSON.parse(raw2||'{}').target);

  const pend1 = await ev(`window.Capacitor.Plugins.StatsWidget.consumePendingScreen().then(function(r){return r.screen})`);
  ok('no widget tap pending on a normal launch', pend1===null||pend1===undefined, pend1);

  console.log('\n' + (f===0 ? `✓ ALL ${pass} PASSED` : `✗ ${f} FAILED (${pass} passed)`));
  process.exit(f===0?0:1);
})().catch(e=>{console.error('ERR',e.message);process.exit(2)});
