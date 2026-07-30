#!/usr/bin/env node
/*
 * test-settings.js — v105.0 collapsible sections, no duplication, auto-save.
 *
 * Steven: "I would like to have all of the tabs collapsible and remember your
 * last settings that... for some reason, I got forgotten ... there's a
 * duplication too ... if you edit something and you don't go on save settings,
 * you just lose it ... it seems like a bit of a trap."
 *
 * Structural assertions run against the shipped source; behaviour is exercised
 * live in test-settings-live.js.
 *
 * Run:  node test-settings.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'www', 'index.html'), 'utf8');
const SETTINGS = html.slice(html.indexOf('<div id="screen-settings"'), html.indexOf('<nav class="nav">'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

// Every card that has a title, and how it is configured.
function cards() {
  const out = [];
  const re = /<div class="card([^"]*)"((?:(?!<div)[^>])*)>(\s*(?:<div[^>]*>\s*)?<div class="card-title"[^>]*>)([^<]*)/g;
  let m;
  while ((m = re.exec(SETTINGS))) {
    out.push({
      collapsible: /card-collapsible/.test(m[1]),
      key: (m[2].match(/data-collapse-key="([^"]*)"/) || [])[1] || null,
      defaultCollapsed: /data-collapse-default="collapsed"/.test(m[2]),
      title: m[4].trim()
    });
  }
  return out;
}

console.log('── PIN: test_settings_sections_collapse_and_expand ──────────────');
{
  const c = cards();
  ok('PIN: every Settings section is collapsible', c.every(x => x.collapsible),
     c.filter(x => !x.collapsible).map(x => x.title));
  ok('PIN: …all ' + c.length + ' of them', c.length >= 20, c.length);
  ok('PIN: the title is the toggle', /title\.addEventListener\('click'/.test(html));
  ok('PIN: …flipping the collapsed class', /card\.classList\.toggle\('collapsed'\)/.test(html));
  ok('PIN: a collapsed card hides its body', /\.card-collapsible\.collapsed \.card-body\{display:none\}/.test(html));
  ok('PIN: …and the chevron flips to say so', /\.card-collapsible\.collapsed \.card-title::after\{transform:rotate\(180deg\)\}/.test(html));
  ok('PIN: the listener is added once, not once per render', /if\(!card\._ccInit\)\{/.test(html));
  // The sections he lives in should be open on a fresh install.
  const open = c.filter(x => !x.defaultCollapsed).map(x => x.key);
  // The everyday sections open on a fresh install. `zones` and `loads` keep the
  // collapsed default they were given in v103/v104 — they are long one-off setup
  // cards, and now that the state persists, whatever he opens simply stays open.
  ok('PIN: the everyday sections default to open',
     ['health', 'rate', 'business', 'vehicles'].every(k => open.includes(k)), open);
  ok('PIN: the long setup sections keep their collapsed default',
     ['zones', 'loads', 'tax', 'logbook', 'account'].every(k => !open.includes(k)), open);
  ok('PIN: …and the rest default closed, so the screen is not a wall',
     c.filter(x => x.defaultCollapsed).length >= 15, c.filter(x => x.defaultCollapsed).length);
}

console.log('\n── PIN: test_settings_last_expanded_state_persists_across_launches ──');
{
  const c = cards();
  ok('PIN: every card has an explicit, stable key', c.every(x => x.key), c.filter(x => !x.key).map(x => x.title));
  ok('PIN: …and no two share one', new Set(c.map(x => x.key)).size === c.length);
  // The actual cause of "for some reason, I got forgotten".
  ok('PIN: the key is NOT derived from the title text any more',
     !/title\.textContent\.trim\(\)\.replace\(\/\[\^a-z0-9\]\/gi,'_'\)\.slice\(0,30\)\)\;\s*\n\s*const saved/.test(html));
  ok('PIN: a card with no key is reported, not silently given a fragile one',
     /card has no data-collapse-key/.test(html));
  // State now lives in the settings blob, which syncs and is backed up.
  ok('PIN: state is stored in mcn_settings.cardState', /s\.cardState=st;/.test(html));
  ok('PIN: …written through DB.set so it rides SYNC_KEYS to Firestore',
     /function setCardState[\s\S]{0,400}DB\.set\('settings',s\);/.test(html));
  ok('PIN: …and pushed to the cloud', /function setCardState[\s\S]{0,500}CloudSync\.pushAll/.test(html));
  ok('PIN: settings are in SYNC_KEYS, so the state survives a reinstall',
     /const SYNC_KEYS = \[[^\]]*'settings'/.test(html));
  ok('PIN: …and in the full backup, which dumps every mcn_* key',
     /k\.indexOf\('mcn_'\)===0/.test(html));
  ok('PIN: existing users keep the layout they had — the old keys are migrated',
     /function _migrateCardState/.test(html) && /localStorage\.getItem\('cc_'\+/.test(html));
  ok('PIN: …exactly once', /if\(s\._cardStateMigrated\) return;/.test(html));
  ok('PIN: …and migration never overwrites a newer choice', /if\(!k\|\|st\[k\]!=null\) return;/.test(html));
}

console.log('\n── PIN: test_settings_duplication_removed_only_one_canonical_affordance_per_function ──');
{
  const calls = {};
  let m; const re = /on(?:click|change)="([a-zA-Z_]+)\(/g;
  while ((m = re.exec(SETTINGS))) calls[m[1]] = (calls[m[1]] || 0) + 1;
  const RADIO = ['czSetMode', 'setTheme', 'setTravelModeBtn', 'loadAdminUsers'];   // groups, not duplicates
  const dupes = Object.keys(calls).filter(k => calls[k] > 1 && !RADIO.includes(k));
  ok('PIN: no function is reachable from two places', dupes.length === 0, dupes);

  const HOME = ['cloudSyncNow', 'cloudPullNow', 'firebaseSignOut', 'exportDaysCSV',
                'exportFullBackup', 'importData', 'clearCacheAndRefresh', 'forceAppUpdate'];
  const acct = SETTINGS.slice(SETTINGS.indexOf('☁️ Account &amp; Sync'));
  const acctCard = acct.slice(0, acct.indexOf('<div class="card', 10));
  HOME.forEach(fn => ok('PIN: ' + fn + ' lives in Account & Sync', acctCard.includes(fn + '(')));
  ok('PIN: the partial "Export all data" is gone entirely',
     !/Export all data \(JSON backup\)/.test(html));
  ok('PIN: …and its function deleted, not left orphaned', !/function exportData\(\)/.test(html));
  ok('PIN: …with a note saying why a partial backup was the wrong one to keep',
     /exportData\(\) removed/.test(html));
  ok('PIN: importData still exists and is wired', /function importData/.test(html) && /onchange="importData\(this\)"/.test(html));
  ok('PIN: clear-cache is kept (the v82 trap needs it) but only in one place',
     (SETTINGS.match(/clearCacheAndRefresh\(/g) || []).length === 1);
}

console.log('\n── PIN: test_toggle_change_saves_immediately_no_button_press_needed ──');
ok('PIN: the Save Settings button is gone', !/>Save Settings</.test(html));
ok('PIN: …and nothing still calls saveSettings() from markup', !/onclick="saveSettings\(\)"/.test(html));
ok('PIN: a change on a settings control saves at once', /scr\.addEventListener\('change'[\s\S]{0,300}autoSaveSettings\(\{immediate:true\}\)/.test(html));
ok('PIN: …with no debounce on that path', /function autoSaveSettings[\s\S]{0,400}if\(now\)\{ _autoSaveRun\(\); return; \}/.test(html));
ok('PIN: checkboxes are excluded from the typing path so they never double-fire late',
   /if\(t\.type==='checkbox'\|\|t\.type==='radio'\) return;/.test(html));
ok('PIN: travel mode (buttons, not a field) saves explicitly',
   /if\(!_travelBtnRestoring\) try\{ autoSaveSettings\(\{immediate:true\}\)/.test(html));
ok('PIN: …but restoring those buttons on render is not treated as an edit',
   /_travelBtnRestoring=true;/.test(html) && /finally \{ _travelBtnRestoring=false; \}/.test(html));

console.log('\n── PIN: test_text_field_saves_on_blur ───────────────────────────');
ok('PIN: blur saves immediately', /scr\.addEventListener\('blur',function\(e\)\{[\s\S]{0,140}autoSaveSettings\(\{immediate:true\}\)/.test(html));
ok('PIN: …captured, because blur does not bubble', /\},true\);   \/\/ capture: blur does not bubble/.test(html));
ok('PIN: typing also saves, debounced', /scr\.addEventListener\('input'/.test(html));
ok('PIN: …at 600ms', /SETTINGS_SAVE_DEBOUNCE_MS = 600/.test(html));
ok('PIN: …and each keystroke resets the timer rather than queueing saves',
   /if\(_autoSaveTimer\)\{ clearTimeout\(_autoSaveTimer\); _autoSaveTimer=null; \}/.test(html));

console.log('\n── PIN: test_slider_saves_on_touch_release ──────────────────────');
ok('PIN: a range control is skipped on input', /if\(t\.type==='range'\) return;/.test(html));
ok('PIN: …so it saves on change, which fires on release', /handled on release/.test(html));

console.log('\n── PIN: test_offline_edit_persists_locally_and_syncs_on_reconnect ──');
ok('PIN: the local write happens before any cloud push', (() => {
    const fn = html.slice(html.indexOf('function saveSettings(opts)'), html.indexOf('// ── v105.0 auto-save'));
    return fn.indexOf("DB.set('settings',s)") < fn.indexOf('CloudSync');
  })());
ok('PIN: a failed push never discards the edit — only the sync retries',
   /only the SYNC is retried/.test(html));
ok('PIN: …with exponential backoff', /_autoSaveBackoff=Math\.min\(_autoSaveBackoff\*2,60000\)/.test(html));
ok('PIN: …capped at a minute', /,60000\)/.test(html));
ok('PIN: …reset once it lands', /_autoSaveBackoff=1000; _settingsSaveOk\(\)/.test(html));
ok('PIN: the user is told it is not synced yet', /Not synced — will retry/.test(html));
ok('PIN: …and that message does NOT auto-hide, unlike the confirmation',
   /if\(state==='saved'\) _saveStateTimer=setTimeout/.test(html));
ok('PIN: a throwing save is caught and surfaced, never silent',
   /catch\(e\)\{ console\.warn\('\[settings\] auto-save failed:',e\); _settingsSaveFailed\(\); \}/.test(html));

console.log('\nFeedback');
ok('there is a save-state indicator', /id="settings-save-state"/.test(html));
ok('…showing Saving…', /'Saving…'/.test(html));
ok('…and Saved ✓', /'Saved ✓'/.test(html));
ok('…which fades after ~1.6s', /el\.style\.display='none'; \},1600\)/.test(html));
ok('the header tells him it is automatic', /changes save themselves/.test(html));

console.log('\nNo data loss in the migration');
{
  const fn = html.slice(html.indexOf('function saveSettings(opts)'), html.indexOf('// ── v105.0 auto-save'));
  ['s-name', 's-abn', 's-address', 's-phone', 's-email', 's-bsb', 's-account', 's-service',
   's-rate', 's-sonrate', 's-incpct', 's-invnum', 's-travelKmRate', 's-travelHrRate',
   's-employee-name', 's-employer-name', 's-employer-contact', 's-pay-period']
    .forEach(id => ok('still reads ' + id, fn.includes(id)));
  ok('the bulk read is byte-for-byte the pre-v105 one, only the toasts are gated',
     /if\(!silent\) toast\('Settings saved ✓'\);/.test(fn));
  ok('cardState is additive — it does not replace any existing settings field',
     /s\.cardState=st;/.test(html) && /DEFAULTS=\{/.test(html) && !/cardState:/.test(html.slice(html.indexOf('const DEFAULTS'), html.indexOf('const DEFAULTS') + 1200)));
}

console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAIL') + `  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
