#!/usr/bin/env node
/*
 * test-zone-radius.js — v104.5 zone radius slider + manual entry + nesting.
 *
 * Steven: "three thousand meter radius is too big for the zones … some of the
 * zones I want, say, fifty meters radius or thirty meter radius, it makes it
 * very hard to select it because it's very touchy … two hundred or two hundred
 * and fifty is probably around the sweet spot."
 *
 * And, separately: "when I collect firewood, I'm gonna go … anywhere in the
 * farm, and then come back to the charcoal shed … I suppose I could just use
 * the pickup area as the farm."
 *
 * That second one is why manual entry exists at all: the firewood shape needs a
 * farm-scale PICKUP zone with the shed DUMP zone sitting inside it. This file
 * pins both, plus the geometry rule that decides when nesting is safe.
 *
 * Synthetic coordinates — this repo is PUBLIC.
 *
 * Run:  node test-zone-radius.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
function extract(start, end) {
  const m = html.match(new RegExp('\\/\\/' + start + '[^\\n]*\\n([\\s\\S]*?)\\/\\/' + end));
  if (!m) { console.error('✗ could not find ' + start); process.exit(2); }
  return m[1];
}
const api = new Function(
  extract('__V102_TRIPLOG_PURE_START__', '__V102_TRIPLOG_PURE_END__') + '\n' +
  extract('__V102_CIRCUIT_PURE_START__', '__V102_CIRCUIT_PURE_END__') + `
return {ZONE_RADIUS, clampZoneRadius, zoneOverlapVerdict, zoneOfPoint, circuitsFromFixes,
        subSessionsFromFixes, CIRCUIT_CFG, _fenceHaversine, ZONE_MODES};`)();
const { ZONE_RADIUS, clampZoneRadius, zoneOverlapVerdict, zoneOfPoint, circuitsFromFixes,
        CIRCUIT_CFG, _fenceHaversine, ZONE_MODES } = api;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

const M = 111320;
const FARM = { id: 'zf', name: 'Farm', mode: 'circuit-pickup', lat: -28.500, lng: 151.900, radius: 2000 };
const SHED = { id: 'zs', name: 'Charcoal shed', mode: 'circuit-dump', lat: -28.500 + 800 / M, lng: 151.900, radius: 50 };

console.log('── PIN: test_zone_radius_slider_max_is_250_and_manual_entry_accepts_up_to_3000 ──');
ok('PIN: the activity-zone slider tops out at 250m', ZONE_RADIUS.slider_max === 250, ZONE_RADIUS.slider_max);
ok('PIN: …and the shipped slider element says so',
   /id="cz-radius"[^>]*max="250"/.test(html), (html.match(/<input type="range" id="cz-radius"[^>]*>/) || [''])[0]);
ok('PIN: …with a fine enough step to pick 30m or 50m', /id="cz-radius"[^>]*step="5"/.test(html));
ok('PIN: …starting low enough for a small shed', /id="cz-radius"[^>]*min="10"/.test(html));
// The complaint in numbers: 50m used to be 1.4% along the travel; now it is 16%.
{
  const oldPct = ((50 - 30) / (3000 - 30)) * 100;
  const newPct = ((50 - ZONE_RADIUS.slider_min) / (ZONE_RADIUS.slider_max - ZONE_RADIUS.slider_min)) * 100;
  ok('PIN: 50m moves from ' + oldPct.toFixed(1) + '% to ' + newPct.toFixed(0) + '% along the slider',
     oldPct < 2 && newPct > 10, { oldPct, newPct });
}
ok('PIN: manual entry accepts up to 3000m', ZONE_RADIUS.manual_max === 3000);
ok('PIN: …and 3000 survives the clamp', clampZoneRadius(3000) === 3000);
ok('PIN: …as does a farm-scale 2000', clampZoneRadius(2000) === 2000);
ok('PIN: …while over 3000 is capped, not rejected', clampZoneRadius(9999) === 3000);
ok('PIN: …and the manual input element allows it', /id="cz-radius-input"[^>]*max="3000"/.test(html));
ok('PIN: the number itself is the tap target', /id="cz-radius-display"[^>]*onclick="czEditRadius\(\)"/.test(html));

console.log('\nClamping');
ok('a normal value passes through', clampZoneRadius(50) === 50);
ok('fractions round', clampZoneRadius(47.6) === 48);
ok('zero floors to the minimum', clampZoneRadius(0) === ZONE_RADIUS.slider_min);
ok('negative floors to the minimum', clampZoneRadius(-5) === ZONE_RADIUS.slider_min);
ok('garbage floors to the minimum', clampZoneRadius('abc') === ZONE_RADIUS.slider_min);
ok('null floors to the minimum', clampZoneRadius(null) === ZONE_RADIUS.slider_min);
ok('an explicit max is honoured', clampZoneRadius(2000, ZONE_RADIUS.slider_max) === 250);

console.log('\nThe work-site fence is a different animal and is NOT capped at 250');
ok('worksite max is still 3000', ZONE_RADIUS.worksite_max === 3000);
ok('…so Lucas Ranch at 2900m still clamps to itself',
   clampZoneRadius(2900, ZONE_RADIUS.worksite_max) === 2900);
// The work-site geofence has its own editor — the map picker — which this
// change does not touch at all.
ok('the map-picker radius control is untouched', /id="modal-radius-display"/.test(html));
ok('…and is a separate control from the zones slider',
   html.indexOf('modal-radius-display') !== html.indexOf('cz-radius-display'));

console.log('\nBackward compatibility — zones saved before v104.5');
{
  // Someone may have set 500m in v103.0 when the slider went to 3000.
  const legacy = { id: 'zl', name: 'Big old pickup', mode: 'circuit-pickup', lat: -28.6, lng: 151.8, radius: 500 };
  ok('a 500m zone still resolves points at its real radius',
     zoneOfPoint(legacy.lat + 400 / M, legacy.lng, [legacy]) !== null);
  ok('…and correctly excludes points beyond it',
     zoneOfPoint(legacy.lat + 600 / M, legacy.lng, [legacy]) === null);
  ok('…and is never silently shrunk to the new slider max',
     clampZoneRadius(legacy.radius) === 500);
  ok('a legacy 3000m zone also survives', clampZoneRadius(3000) === 3000);
}

console.log('\nOverlap: partial is still refused, containment is now allowed');
ok('two separate zones are fine',
   zoneOverlapVerdict(-28.6, 151.8, 50, [SHED]).ok === true);
{
  // Half-overlapping same-size zones: genuinely ambiguous, still refused.
  const a = { id: 'a', name: 'Pit A', lat: -28.5, lng: 151.9, radius: 100 };
  const v = zoneOverlapVerdict(-28.5 + 120 / M, 151.9, 100, [a]);
  ok('half-overlapping zones are refused', v.ok === false && v.reason === 'partial', v);
  ok('…naming the zone it clashes with', v.zone && v.zone.name === 'Pit A');
}
{
  // THE FIREWOOD SHAPE: shed wholly inside the farm, well off-centre.
  const v = zoneOverlapVerdict(SHED.lat, SHED.lng, SHED.radius, [FARM]);
  ok('a small dump zone INSIDE a big pickup zone is allowed', v.ok === true, v);
  ok('…and so is the reverse order (farm added after the shed)',
     zoneOverlapVerdict(FARM.lat, FARM.lng, FARM.radius, [SHED]).ok === true);
}
{
  // The one containment case that genuinely breaks the detector.
  const v = zoneOverlapVerdict(FARM.lat + 30 / M, FARM.lng, 50, [FARM]);
  ok('a zone near the MIDDLE of a big one is refused', v.ok === false && v.reason === 'concentric', v);
  ok('…because part of it would be swallowed by the big zone', (() => {
      const inner = { id: 'zi', name: 'Inner', mode: 'circuit-dump', lat: FARM.lat + 30 / M, lng: FARM.lng, radius: 50 };
      // The failure is at the OUTER centre, not near the inner one. The farm's
      // centre lies inside `inner` (30m < 50m), and there the farm centre is
      // 0m away while the inner centre is 30m — so Farm wins and that part of
      // the dump zone is dead. Nearer the inner centre it still works, which is
      // exactly what makes this a silent, partial failure worth refusing.
      const atOuterCentre = (zoneOfPoint(FARM.lat, FARM.lng, [FARM, inner]) || {}).name;
      const nearInner     = (zoneOfPoint(inner.lat, inner.lng, [FARM, inner]) || {}).name;
      return atOuterCentre === 'Farm' && nearInner === 'Inner';
    })());
  ok('…whereas the allowed firewood layout has no such dead spot', (() => {
      // Every point inside the shed resolves to the shed — sampled around it.
      const pts = [[0,0],[40,0],[-40,0],[0,40],[0,-40],[30,30],[-30,-30]];
      return pts.every(([dn,de]) =>
        (zoneOfPoint(SHED.lat + dn / M, SHED.lng + de / M, [FARM, SHED]) || {}).name === 'Charcoal shed');
    })());
  ok('the boundary is exactly d > 2·rInner', (() => {
      const justInside = zoneOverlapVerdict(FARM.lat + 99 / M, FARM.lng, 50, [FARM]);   // d≈99 ≤ 100
      const justOutside = zoneOverlapVerdict(FARM.lat + 101 / M, FARM.lng, 50, [FARM]); // d≈101 > 100
      return justInside.ok === false && justOutside.ok === true;
    })());
  ok('two identical concentric zones are refused (the shed-as-two-modes case)',
     zoneOverlapVerdict(SHED.lat, SHED.lng, 50, [SHED]).ok === false);
}
ok('an existing zone with no coordinates is skipped, not crashed on',
   zoneOverlapVerdict(-28.5, 151.9, 50, [{ id: 'x', name: 'broken' }]).ok === true);
ok('an empty zone list is fine', zoneOverlapVerdict(-28.5, 151.9, 50, []).ok === true);
ok('a null zone list is fine', zoneOverlapVerdict(-28.5, 151.9, 50, null).ok === true);

console.log('\n── The firewood workflow, end to end ─────────────────────────');
{
  const Z = [FARM, SHED];
  const T0 = Date.parse('2026-07-30T08:00:00');
  const north = (m, s) => ({ lat: FARM.lat + m / M, lng: FARM.lng, t: T0 + s * 1000 });
  const atShed = (m, s) => ({ lat: SHED.lat + m / M, lng: SHED.lng, t: T0 + s * 1000 });

  ok('setup is permitted: the shed can be saved inside the farm',
     zoneOverlapVerdict(SHED.lat, SHED.lng, SHED.radius, [FARM]).ok === true);
  ok('out in the paddock he is in the FARM (pickup)',
     (zoneOfPoint(north(600, 0).lat, FARM.lng, Z) || {}).name === 'Farm');
  ok('at the shed he is in the SHED, not the farm that contains it',
     (zoneOfPoint(SHED.lat, SHED.lng, Z) || {}).name === 'Charcoal shed');
  ok('…and 100m from the shed he is back to the farm',
     (zoneOfPoint(atShed(100, 0).lat, SHED.lng, Z) || {}).name === 'Farm');
  ok('off the farm entirely he is in no zone',
     zoneOfPoint(north(2500, 0).lat, FARM.lng, Z) === null);

  // Two loads of firewood: gather across the paddock, haul to the shed, back out.
  const fx = []; let t = 0;
  for (let lap = 0; lap < 2; lap++) {
    for (let s = 0; s <= 600; s += 60) fx.push(north(300 + (s % 180), t + s));  // gathering
    t += 660;
    for (let s = 0; s <= 180; s += 60) fx.push(atShed(10, t + s));              // unloading
    t += 240;
  }
  for (let s = 0; s <= 120; s += 60) fx.push(north(300, t + s));                // back out
  const r = circuitsFromFixes(fx, Z, CIRCUIT_CFG);
  ok('two firewood loads are recorded', r.circuits.length === 2, r.circuits.length);
  ok('…as Farm → Charcoal shed',
     r.circuits.every(c => c.pickup_name === 'Farm' && c.dump_name === 'Charcoal shed'));
  ok('…with nothing abandoned', r.abandoned.length === 0, r.abandoned);
  ok('…and a real phase breakdown (gathering shows as the load phase)',
     r.circuits[0].load_s > 0 && r.circuits[0].dump_s > 0 && r.circuits[0].duration_s > 0);
  ok('…the visit stream alternates cleanly',
     r.visits.map(v => v.zone_name).join('>') === 'Farm>Charcoal shed>Farm>Charcoal shed>Farm',
     r.visits.map(v => v.zone_name).join('>'));
  ok('the nested dump zone never gets read as a pickup',
     r.visits.filter(v => v.zone_name === 'Charcoal shed').every(v => v.mode === 'circuit-dump'));
}

console.log('\nA tight yard still works exactly as before — this is not a farm-only rule');
{
  const PIT = { id: 'p', name: 'Pit', mode: 'circuit-pickup', lat: -28.5, lng: 151.9, radius: 30 };
  const TIP = { id: 't', name: 'Tip', mode: 'circuit-dump', lat: -28.5 + 300 / M, lng: 151.9, radius: 30 };
  ok('two small separate zones are allowed',
     zoneOverlapVerdict(TIP.lat, TIP.lng, TIP.radius, [PIT]).ok === true);
  const T0 = Date.parse('2026-07-30T08:00:00');
  const at = (z, m, s) => ({ lat: z.lat + m / M, lng: z.lng, t: T0 + s * 1000 });
  const mid = s => ({ lat: (PIT.lat + TIP.lat) / 2, lng: PIT.lng, t: T0 + s * 1000 });
  const fx = [];
  let t = 0;
  for (let i = 0; i < 2; i++) {
    fx.push(at(PIT, 0, t), at(PIT, 5, t + 60)); fx.push(mid(t + 120));
    fx.push(at(TIP, 0, t + 180), at(TIP, 5, t + 240)); fx.push(mid(t + 300));
    t += 360;
  }
  fx.push(at(PIT, 0, t), at(PIT, 5, t + 60));
  const r = circuitsFromFixes(fx, [PIT, TIP], CIRCUIT_CFG);
  ok('30m zones 300m apart still record their laps', r.circuits.length === 2, r.circuits.length);
}

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
