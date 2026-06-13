#!/usr/bin/env bash
# test-emulator.sh — boot the Pixel_7_API34 AVD, install the debug APK, launch
# the invoice app, and print commands for simulating geofence transitions.
#
# Re-runnable: tears down nothing, but reuses a running emulator if one is up.
#
# Quick-start:
#   bash test-emulator.sh
#
# Set AVD_NAME / APK_PATH env vars to override defaults.

set -euo pipefail

# ---- config -------------------------------------------------------------
AVD_NAME="${AVD_NAME:-Pixel_7_API34}"
PKG="com.banksiasprings.invoices"
ACTIVITY="${PKG}.MainActivity"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK_PATH="${APK_PATH:-${PROJECT_DIR}/android/build/android/app/outputs/apk/debug/app-debug.apk}"

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
EMU="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"

# Emulator flags. -no-snapshot-save keeps the AVD reproducible run-to-run.
# -timezone matters: the geofence receiver ignores events outside 5am–9pm
# DEVICE-LOCAL time — a UTC emulator clock silently swallows every event.
# Drop -no-window if you want to see the device window.
EMU_FLAGS=(-avd "$AVD_NAME" -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect -timezone Australia/Brisbane)
if [[ "${HEADLESS:-0}" == "1" ]]; then
  EMU_FLAGS+=(-no-window -no-audio)
fi

# ---- preflight ----------------------------------------------------------
[[ -x "$EMU" ]]  || { echo "✗ emulator binary missing at $EMU"; exit 1; }
[[ -x "$ADB" ]]  || { echo "✗ adb binary missing at $ADB"; exit 1; }
[[ -f "$APK_PATH" ]] || {
  echo "✗ APK not found at $APK_PATH"
  echo "  Build it first:"
  echo "    cd '$PROJECT_DIR' && npx cap sync android && (cd android && ./gradlew assembleDebug)"
  exit 1
}
"$EMU" -list-avds | grep -qx "$AVD_NAME" || {
  echo "✗ AVD '$AVD_NAME' not found. Available AVDs:"
  "$EMU" -list-avds | sed 's/^/    /'
  exit 1
}

# ---- start (or reuse) emulator -----------------------------------------
if "$ADB" devices | awk 'NR>1 && $2=="device"' | grep -q emulator-; then
  SERIAL="$("$ADB" devices | awk 'NR>1 && $2=="device" && $1 ~ /^emulator-/ {print $1; exit}')"
  echo "→ Reusing running emulator: $SERIAL"
else
  LOG="/tmp/${AVD_NAME}-emulator.log"
  echo "→ Booting AVD '$AVD_NAME' (log: $LOG)…"
  nohup "$EMU" "${EMU_FLAGS[@]}" >"$LOG" 2>&1 &
  EMU_PID=$!
  echo "  PID: $EMU_PID"

  # adb wait-for-device blocks until the device is visible; then poll boot prop.
  "$ADB" wait-for-device
  SERIAL="$("$ADB" devices | awk 'NR>1 && $2=="device" && $1 ~ /^emulator-/ {print $1; exit}')"
  echo "→ Device online: $SERIAL — waiting for sys.boot_completed=1…"

  for i in $(seq 1 90); do
    BOOTED="$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "$BOOTED" == "1" ]]; then
      echo "✓ Boot complete after ${i}0s (approx)"
      break
    fi
    sleep 10
  done
  if [[ "${BOOTED:-}" != "1" ]]; then
    echo "✗ Timed out waiting for boot. Tail of emulator log:"
    tail -40 "$LOG"
    exit 1
  fi
  # Unlock the device so the app can be launched.
  "$ADB" -s "$SERIAL" shell input keyevent 82 >/dev/null 2>&1 || true
fi

# ---- install + launch ---------------------------------------------------
echo "→ Installing $APK_PATH …"
"$ADB" -s "$SERIAL" install -r -g "$APK_PATH"

echo "→ Granting runtime location permissions (geofencing needs background)…"
for P in \
  android.permission.ACCESS_FINE_LOCATION \
  android.permission.ACCESS_COARSE_LOCATION \
  android.permission.ACCESS_BACKGROUND_LOCATION \
  android.permission.POST_NOTIFICATIONS \
  android.permission.FOREGROUND_SERVICE_LOCATION ; do
  "$ADB" -s "$SERIAL" shell pm grant "$PKG" "$P" 2>/dev/null || true
done

echo "→ Launching $ACTIVITY …"
"$ADB" -s "$SERIAL" shell am start -n "$PKG/$ACTIVITY"

# ---- test recipes -------------------------------------------------------
cat <<EOF

════════════════════════════════════════════════════════════════════════════
✓ Emulator up. Device serial: $SERIAL
════════════════════════════════════════════════════════════════════════════

GEOFENCE TEST RECIPES — three options, in order of fidelity:

1) MOVE THE EMULATOR'S GPS (recommended — exercises the real GMS pipeline)
   First add a site in the app (Settings → Sites) with known lat/lng — e.g.
   -28.6532, 151.9282 for Stanthorpe. Then move GPS in/out of its radius:

     # ENTER fence: drop GPS exactly on the site
     $ADB -s $SERIAL emu geo fix 151.9282 -28.6532

     # EXIT fence: move 2 km away (~0.02° latitude)
     $ADB -s $SERIAL emu geo fix 151.9282 -28.6732

   GMS detects the transition and fires GeofenceBroadcastReceiver naturally.
   Watch logcat: $ADB -s $SERIAL logcat -s GeofenceReceiver NativeGeoPlugin

2) WRITE DIRECTLY TO SharedPreferences (bypasses GMS, fastest)
   The receiver persists events to native_geo_prefs::pending_events and JS
   replays them on app open. Inject a fake ENTER event for "Test Site":

     NOW=\$(date +%s)000
     TIME=\$(date +%H:%M)
     DATE=\$(date +%Y-%m-%d)
     EV='[{"site":"Test Site","type":"enter","time":"'\$TIME'","date":"'\$DATE'","timestamp":'\$NOW'}]'
     $ADB -s $SERIAL shell "run-as $PKG sh -c 'mkdir -p shared_prefs && cat > shared_prefs/native_geo_prefs.xml'" <<XML
<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
  <string name="pending_events">\$EV</string>
</map>
XML
   Then force-stop and relaunch the app:
     $ADB -s $SERIAL shell am force-stop $PKG
     $ADB -s $SERIAL shell am start -n $PKG/$ACTIVITY

3) RAW BROADCAST (NOTE: limited)
   The receiver calls GeofencingEvent.fromIntent() which needs GMS Parcelable
   extras — not constructible from a shell. The command below DELIVERS the
   intent but the receiver early-returns on the malformed event. Useful only
   to confirm the receiver is registered:

     $ADB -s $SERIAL shell am broadcast \\
       -a com.banksiasprings.invoices.GEOFENCE_TRANSITION \\
       -n $PKG/.GeofenceBroadcastReceiver

   For actual end-to-end geofence behaviour, use option 1.

────────────────────────────────────────────────────────────────────────────
SHUT DOWN: $ADB -s $SERIAL emu kill
LOGCAT:    $ADB -s $SERIAL logcat -s GeofenceReceiver NativeGeoPlugin Capacitor
APP DATA:  $ADB -s $SERIAL shell pm clear $PKG
EOF
