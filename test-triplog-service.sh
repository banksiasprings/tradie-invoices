#!/usr/bin/env bash
# test-triplog-service.sh — v101.6 integration tests on the emulator.
#
# ── THE BUG THIS PINS ────────────────────────────────────────────────────────
# v100–v101.5 drove trip capture from JS via @capacitor-community/background-
# geolocation's addWatcher(). That plugin tears down its own service the moment
# the host Activity is destroyed:
#
#     // BackgroundGeolocation.java
#     protected void handleOnDestroy() { if (service != null) service.stopService(); }
#
# Steven's Moto Edge 50 Neo destroys MainActivity as soon as the app is
# backgrounded, so trip capture only ever ran while he was looking at the
# screen — never while driving. Field telemetry agreed: zero auto-detected
# trips in a month, and zero GeoLog entries after each morning's app open.
#
# The observable property that fixes it: the app must hold a real FOREGROUND
# LOCATION service of its own, so the OS both keeps the process alive and keeps
# delivering fixes with no Activity present. These tests assert exactly that,
# including the A/B contrast that demonstrates the mechanism:
#
#   T1 TripLogService runs as a foreground LOCATION service on app open
#   T2 with it running, the system CANNOT reclaim the process (am kill)   ← pin
#   T3 with it stopped, the system DOES reclaim the process               ← the
#      pre-v101.6 condition, i.e. what was killing trip capture every day
#   T4 it survives the app being backgrounded
#   T5 GPS fixes are banked to SharedPreferences with the app backgrounded
#   (BootReceiver reboot-restart: NOT automated — emulator will not deliver the
#    boot broadcast; see the T6 note below)
#   T7 live JS: reconstruction, idempotent replay, stale-activeDay seal
#
# Requires a booted emulator + InvoicePDF-latest.apk.
# Run:  bash test-triplog-service.sh
#
# FLAKINESS: T2/T3/T5 depend on emulator timing (when `am kill` is allowed to
# reclaim a process, and when the fused provider delivers). Both now retry, but
# a single red run is worth repeating before treating it as a real regression —
# measured 3 clean runs out of 4 before the retries went in. The pure suite
# (node test-triplog.js) has no such dependency and is the fast signal.
set -u
PKG=com.banksiasprings.invoices
DIR="$(cd "$(dirname "$0")" && pwd)"
ADB="${ADB:-adb}"
APK="${APK:-$DIR/InvoicePDF-latest.apk}"
export ADB
export WS_NODE_PATH="${WS_NODE_PATH:-/usr/local/lib/node_modules/openclaw/node_modules}"

pass=0; fail=0
ok(){ if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  ✓ $1"; else fail=$((fail+1)); echo "  ✗ $1${3:+  → $3}"; fi; }

pid_of(){ $ADB shell pidof $PKG 2>/dev/null | tr -d '\r'; }
# Is OUR trip service present AND holding a foreground notification?
# awk block-scan rather than `grep -A`: isForeground sits well below the
# ServiceRecord header line, and `{`/`}` in the record id break BRE matchers.
triplog_fg(){
  $ADB shell dumpsys activity services $PKG 2>/dev/null | awk '
    /ServiceRecord.*TripLogService/ {inblk=1; next}
    /^  \* ServiceRecord/ && inblk {inblk=0}
    inblk && /isForeground=true/ {fg=1}
    END{print fg+0}'
}
triplog_type(){
  $ADB shell dumpsys activity services $PKG 2>/dev/null | awk '
    /ServiceRecord.*TripLogService/ {inblk=1; next}
    /^  \* ServiceRecord/ && inblk {inblk=0}
    inblk && match($0,/types=[0-9]+/) {print substr($0,RSTART,RLENGTH); exit}'
}
banked_fixes(){
  $ADB shell run-as $PKG cat /data/data/$PKG/shared_prefs/native_geo_prefs.xml 2>/dev/null \
    | command grep -o '&quot;lat&quot;' | wc -l | tr -d ' '
}
launch(){ $ADB shell am start -n $PKG/.MainActivity >/dev/null 2>&1; }
# Wait until the WebView has finished loading the app (Capgo can reload once on
# cold start, which tears down the JS context mid-eval).
wait_ready(){
  for _ in $(seq 1 30); do
    if [ "$(node "$DIR/cdp-eval.js" "typeof APP_VERSION" 2>/dev/null)" = "string" ]; then return 0; fi
    sleep 2
  done
  return 1
}

echo "=== setup ==="
$ADB wait-for-device >/dev/null 2>&1
$ADB install -r -g "$APK" >/dev/null 2>&1 || { echo "✗ install failed"; exit 2; }
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION ACCESS_BACKGROUND_LOCATION POST_NOTIFICATIONS; do
  $ADB shell pm grant $PKG android.permission.$p >/dev/null 2>&1
done
$ADB shell cmd deviceidle whitelist +$PKG >/dev/null 2>&1
$ADB emu geo fix 151.930 -28.650 >/dev/null 2>&1
$ADB shell am force-stop $PKG >/dev/null 2>&1
launch
wait_ready || { echo "✗ app never became ready"; exit 2; }
echo "  installed, permissions granted, app v$(node "$DIR/cdp-eval.js" "APP_VERSION" 2>/dev/null)"

# ── T1 ───────────────────────────────────────────────────────────────────────
echo
echo "=== T1: TripLogService starts as a foreground LOCATION service ==="
sleep 6   # ensureTripLogging() fires at 2.5s
fg=$(triplog_fg); ty=$(triplog_type)
ok "TripLogService is a FOREGROUND service on app open (auto-detect default ON)" \
   "$([ "${fg:-0}" -ge 1 ] && echo 1 || echo 0)" "isForeground count=$fg"
# 0x8 == FOREGROUND_SERVICE_TYPE_LOCATION
ok "declared foregroundServiceType = LOCATION (0x8)" \
   "$([ "$ty" = "types=00000008" ] && echo 1 || echo 0)" "$ty"

# ── T2 (the pin) ─────────────────────────────────────────────────────────────
echo
echo "=== T2: the process survives system reclaim while trip logging is ON ==="
$ADB shell input keyevent KEYCODE_HOME >/dev/null 2>&1; sleep 5
before=$(pid_of)
ok "app is backgrounded and still alive" "$([ -n "$before" ] && echo 1 || echo 0)" "pid=$before"
# `am kill` is the SAFE kill — it reclaims background processes exactly the way
# the OS (and Motorola's battery manager) does. It refuses a process holding a
# foreground service.
$ADB shell am kill $PKG >/dev/null 2>&1; sleep 5
after=$(pid_of)
ok "PIN: system could NOT reclaim the process (foreground service protects it)" \
   "$([ "$after" = "$before" ] && [ -n "$after" ] && echo 1 || echo 0)" "before=$before after=$after"
ok "…and the service is still foreground after the kill attempt" \
   "$([ "$(triplog_fg)" -ge 1 ] && echo 1 || echo 0)"

# ── T3 (the contrast — this is what used to happen every day) ────────────────
echo
echo "=== T3: with trip logging OFF the process IS reclaimed (pre-v101.6) ==="
launch; wait_ready || true
# Turn it off the way the USER does — through the Settings toggle, which writes
# mcn_settings.tripAutoDetect. Calling setTripBgWatcher(false) alone leaves the
# preference ON, so the next resume's ensureTripLogging() correctly re-arms it
# (that is the designed behaviour, and it made this test flaky until it drove
# the real path).
node "$DIR/cdp-eval.js" "(async()=>{ document.getElementById('s-trip-autodetect').checked=false;
  saveTripAutoDetectPref(); return 'off'; })()" >/dev/null 2>&1
off=1
for _ in 1 2 3 4 5; do sleep 3; [ "$(triplog_fg)" -eq 0 ] && { off=0; break; }; done
ok "no foreground service once trip logging is off" \
   "$([ "$off" -eq 0 ] && echo 1 || echo 0)" "count=$(triplog_fg)"
# `am kill` only reclaims processes that have dropped out of the recently-used
# tier, so give it time to settle and retry a couple of times before judging.
$ADB shell input keyevent KEYCODE_HOME >/dev/null 2>&1; sleep 10
p1=$(pid_of); p2="$p1"
for _ in 1 2 3; do
  $ADB shell am kill $PKG >/dev/null 2>&1; sleep 6
  p2=$(pid_of); [ -z "$p2" ] && break
done
ok "CONTRAST: without the service the process IS killed (capture would stop)" \
   "$([ -n "$p1" ] && [ -z "$p2" ] && echo 1 || echo 0)" "before=$p1 after='$p2'"

# ── T4 + T5 ──────────────────────────────────────────────────────────────────
echo
echo "=== T4/T5: survives backgrounding and banks fixes while backgrounded ==="
$ADB shell am force-stop $PKG >/dev/null 2>&1
launch; wait_ready || true
# Restore the preference T3 turned off, then arm.
node "$DIR/cdp-eval.js" "(async()=>{ document.getElementById('s-trip-autodetect').checked=true;
  saveTripAutoDetectPref(); return 'on'; })()" >/dev/null 2>&1
sleep 4
# Clear the banked queue so the count below is unambiguous.
node "$DIR/cdp-eval.js" "(async()=>{ await window.Capacitor.Plugins.NativeGeo.drainTripFixes(); return 'cleared'; })()" >/dev/null 2>&1
$ADB shell input keyevent KEYCODE_HOME >/dev/null 2>&1; sleep 6
ok "service still foreground with the app backgrounded" \
   "$([ "$(triplog_fg)" -ge 1 ] && echo 1 || echo 0)"

# Drive ~200m per step so each step clears the 25m displacement filter.
# The emulator's fused provider delivers on its own schedule, so keep driving
# until enough fixes land rather than sampling once and hoping.
lat=-28.650
n=0
for i in $(seq 1 18); do
  lat=$(awk -v l="$lat" 'BEGIN{printf "%.6f", l-0.0018}')
  $ADB emu geo fix 151.930 "$lat" >/dev/null 2>&1
  sleep 7
  [ $((i % 3)) -eq 0 ] && n=$(banked_fixes) && [ "${n:-0}" -ge 3 ] && break
done
ok "PIN: GPS fixes banked while the app was backgrounded" \
   "$([ "${n:-0}" -ge 3 ] && echo 1 || echo 0)" "banked=$n"

# ── T6: NOT AUTOMATED — see NIGHT_LOG 2026-07-27 ─────────────────────────────
# BootReceiver also restarts trip logging after a reboot (same receiver that
# already re-registers geofences). It is NOT asserted here because this
# emulator delivers neither trigger to the app: BOOT_COMPLETED is a protected
# broadcast that shell cannot send, a real `adb reboot` produced no delivery to
# the package, and MY_PACKAGE_REPLACED via `adb install -r` no longer fires
# either (the technique documented in test-geo-scenarios.sh has bit-rotted on
# this API level). The receiver now logs unconditionally on entry, and a failed
# foreground-service start is recorded to prefs and surfaced in the Setup Health
# card — so if the boot path does fail on the phone it is visible, not silent.
# Cold-start and resume re-arming (T1/T7) cover the same ground on every app open.

# ── T7 ───────────────────────────────────────────────────────────────────────
echo
echo "=== T7: live JS — reconstruction, idempotency, stale-activeDay seal ==="
$ADB shell am force-stop $PKG >/dev/null 2>&1
launch
wait_ready || { echo "  ✗ app not ready for live suite"; fail=$((fail+1)); }
node "$DIR/test-triplog-live.js"
rc=$?
if [ $rc -eq 0 ]; then pass=$((pass+1)); echo "  ✓ live CDP suite passed"; else fail=$((fail+1)); echo "  ✗ live CDP suite failed"; fi

echo
echo "$([ $fail -eq 0 ] && echo '✅ ALL PASS' || echo '❌ FAIL')  ($pass passed, $fail failed)"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
