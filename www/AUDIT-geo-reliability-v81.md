# AUDIT: Geofence Reliability — v81

**Date:** 2026-06-13
**Trigger:** Steven's report — random notifications, "fake" geolocation data,
inconsistent timer start/stop, GeoLog can't validate GPS because it has no
source of truth, APK iteration too painful to test.
**Scope:** Full review of both geo pathways (Java + JS), v75–v80 release
history, existing audits (May 2026), and the test tooling.

---

## Verdict

v75–v80 were all geofence point-fixes — symptoms patched, structure untouched.
Five structural root causes remained. All five are fixed in v81.

## Root causes → fixes

### 1. Synthetic ENTER on every app open at a site
`initNativeGeo()` re-registers all fences on every app open, and registration
used `INITIAL_TRIGGER_ENTER` — Android fires a synthetic ENTER for any fence
you're *currently inside at registration time*. So every app open at a site
fired a fresh ENTER. After `saveDay()` (which intentionally clears the trigger
flags for multi-job days) or an app kill (flags were in-memory), that synthetic
ENTER restarted the timer and re-fired the arrival notification.
**This was the main source of "random notifications" and duplicate starts.**

**Fix:** `setInitialTrigger(0)` in the new `GeoRegistrar.buildRequest()`.
Re-registration is now harmless. Real crossings still fire normally.

### 2. No GPS validation on the native path — the missing source of truth
The web GPS path discards fixes with accuracy >100m. The native path had
nothing: fences fire off fused location (wifi/cell guesses — rural Granite Belt
can be km off), and the receiver recorded only *site, type, time*. The GeoLog
could not distinguish a real arrival from a fused-location jump — exactly the
"log assumes incorrect data is right" problem.

**Fix:** receiver now captures `GeofencingEvent.getTriggeringLocation()` and
attaches `evLat, evLng, acc, fixAgeMs, distM` (distance to the fence centre,
computed against the persisted site list) to every event. Events triggered by
a fix with accuracy worse than 150m are marked `rejected:true` + reason —
logged in the GeoLog for visibility, never acted on.

### 3. The 30s anti-flutter loiter was a no-op
`setLoiteringDelay(30000)` only applies to DWELL transitions. Fences were
registered ENTER|EXIT, so the delay did literally nothing — zero entry-side
flutter protection at the native layer.

**Fix:** fences are now DWELL(30s)|EXIT. Entry fires only after 30s inside.
The receiver maps DWELL→`enter` (ENTER kept for stale fences from older APKs).

### 4. Trigger flags + notification guards reset on app kill (old FIX-3/FIX-4)
`geoAutoStartTriggered` & co. and `_lastArrivalNotifyDate` & co. were
in-memory only. Any process kill reset them — combined with #1 this produced
same-day duplicate starts and notifications.

**Fix:** persisted to `mcn_geoFlags` after every mutation (`_saveGeoFlags()`),
restored on startup only when the saved date is today. `saveDay()`'s
intentional same-day reset persists too — lifecycle unchanged, just kill-proof.

### 5. Geofences dead after reboot
`BootReceiver` tried to launch MainActivity on BOOT_COMPLETED — Android 10+
blocks background activity starts, so it silently did nothing. Android drops
all geofences on reboot; they stayed dead until the next manual app open.

**Fix:** `BootReceiver` now calls `GeoRegistrar.registerFromPrefs()` — rebuilds
fences directly from the persisted site list, no UI involved.

## New capabilities

- **GeoLogMirror** — every day's GeoLog entries are mirrored (debounced,
  best-effort) to Firestore `users/{uid}/geolog/{date}`. Real workdays are now
  remotely readable telemetry: enriched events make the log self-validating
  (accuracy + distance on every native event). Look for `REJECTED` entries to
  see the accuracy gate working in the field.
- **Web-GPS auto-start fallback on native** — if the native enter never fired,
  opening the app at the site still starts the timer (idempotent with the
  native path via persisted flags + activeDay guard). Auto-stop stays
  native-owned.
- **Emulator scenario harness** — `test-geo-scenarios.sh` drives
  `adb emu geo fix` through register/enter/exit scenarios and asserts on
  receiver logcat + the persisted event queue, with no UI/auth dependency
  (sites seeded via SharedPreferences + BOOT_COMPLETED broadcast).

## Iteration model going forward

- JS changes: OTA only — bump `APP_VERSION`, push, done. No APK reinstall.
- Java changes: batch them; one APK build via `build_apk.sh`, verify with
  `test-geo-scenarios.sh` before installing on the phone.
- Field diagnosis: read the mirrored GeoLog from Firestore instead of
  borrowing the phone.
