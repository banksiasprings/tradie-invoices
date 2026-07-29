#!/usr/bin/env node
/*
 * test-earthmoving-mode.js — v101.9 single-user earthmoving mode.
 *
 * Extracts the //__V1019_MODE_PURE_START__ / __V1019_MODE_PURE_END__ block
 * VERBATIM from www/index.html.
 *
 * The requirement is explicitly two-way: flag ON shows only the
 * earthmoving-relevant settings, flag OFF restores the full multi-trade config
 * surface. Nothing is deleted — Steven may productise later.
 *
 * Run:  node test-earthmoving-mode.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
const m = html.match(/\/\/__V1019_MODE_PURE_START__[^\n]*\n([\s\S]*?)\/\/__V1019_MODE_PURE_END__/);
if (!m) { console.error('✗ could not find v101.9 mode markers in www/index.html'); process.exit(2); }
const { isEarthmovingModeOn, settingsSurface } =
  new Function(m[1] + 'return {isEarthmovingModeOn, settingsSurface};')();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

console.log('The flag itself');
ok('default is ON (no setting saved yet)', isEarthmovingModeOn({}) === true);
ok('undefined settings default ON', isEarthmovingModeOn(undefined) === true);
ok('explicit true is ON', isEarthmovingModeOn({ earthmovingMode: true }) === true);
ok('only an explicit false turns it off', isEarthmovingModeOn({ earthmovingMode: false }) === false);
// Guard against a truthiness bug reading a legacy record where the key is absent
// but other keys exist — absence must mean ON, not OFF.
ok('a populated settings blob with no flag is still ON',
   isEarthmovingModeOn({ rate: 60, tradeType: 'earthmoving' }) === true);

console.log('\nFlag ON — the surface Steven sees');
const on = settingsSurface({ earthmovingMode: true, tradeType: 'earthmoving' }, 1);
ok('trade selector hidden (one trade now)', on.tradeSelector === false);
ok('team / employee-code card hidden (he is solo)', on.teamCard === false);
ok('employee details card hidden', on.employeeCard === false);
ok('“+ Add vehicle” hidden once he has one', on.addVehicle === false);
ok('per-trip vehicle picker hidden with a single vehicle', on.vehiclePicker === false);
ok('the mode reports itself as on', on.earthmovingMode === true);

console.log('\nFlag ON — but the surface must not lock him out');
// The vehicles card carries the cents/km rate, so it always stays; only the
// multi-vehicle affordances come and go.
ok('with NO vehicle yet, Add vehicle is still offered',
   settingsSurface({ earthmovingMode: true }, 0).addVehicle === true);
ok('…and with two vehicles the picker comes back',
   settingsSurface({ earthmovingMode: true }, 2).vehiclePicker === true);
ok('…but Add stays hidden at two (mode is what hides it)',
   settingsSurface({ earthmovingMode: true }, 2).addVehicle === false);
// An employee-mode user must keep the trade selector or they can never leave.
const emp = settingsSurface({ earthmovingMode: true, tradeType: 'employee' }, 1);
ok('employee mode keeps the trade selector (the only way out)', emp.tradeSelector === true);
ok('…and keeps its own settings card', emp.employeeCard === true);
ok('…and still has no team card (employees are not bosses)', emp.teamCard === false);

console.log('\nFlag OFF — the full config surface returns');
const off = settingsSurface({ earthmovingMode: false, tradeType: 'earthmoving' }, 1);
ok('trade selector back', off.tradeSelector === true);
ok('team card back', off.teamCard === true);
ok('Add vehicle back', off.addVehicle === true);
ok('vehicle picker back', off.vehiclePicker === true);
ok('the mode reports itself as off', off.earthmovingMode === false);
ok('employee card still only for employees', off.employeeCard === false);
ok('…and does appear for an employee with the flag off',
   settingsSurface({ earthmovingMode: false, tradeType: 'employee' }, 1).employeeCard === true);

console.log('\nRound trip');
// The toggle must be genuinely reversible — this is the whole point of
// feature-flagging instead of deleting.
const cycle = [true, false, true].map(f => settingsSurface({ earthmovingMode: f }, 1).tradeSelector);
ok('ON → OFF → ON restores the same surface each time',
   JSON.stringify(cycle) === JSON.stringify([false, true, false]), cycle);
ok('no settings at all behaves like ON', settingsSurface(null, 1).tradeSelector === false);
ok('missing vehicle count does not throw',
   settingsSurface({ earthmovingMode: false }).addVehicle === true);

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
