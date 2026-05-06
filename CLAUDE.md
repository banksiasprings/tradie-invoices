# CLAUDE.md — Invoice & PDF Generator (tradie-invoices)

> This is the authoritative reference for all coding sessions on this project.
> Read this fully before making ANY changes. Many mistakes happen from not knowing what's already built.

---

## Project Overview

A sole-trader business tool for Steven McNichol (earthmoving/construction, Stanthorpe QLD).
Primary client: Muirlawn Pty Ltd.

- **PWA:** `https://banksiasprings.github.io/tradie-invoices/` (GitHub Pages, `www/` subfolder)
- **APK:** Capacitor v8 Android wrapper — distributed via direct share / Firebase App Distribution
- **Repo:** `https://github.com/banksiasprings/tradie-invoices`
- **Local path (Steven's Mac):** `~/Documents/mcnichol-invoices`
- **VM path:** `/sessions/keen-eloquent-cray/mnt/Documents/mcnichol-invoices`

---

## Version Numbers — ALWAYS BUMP ON EVERY CHANGE

Three version numbers must stay in sync:

| # | File | Variable | Current |
|---|---|---|---|
| 1 | `www/index.html` | `const APP_VERSION = 'vN'` (line ~1558) | v64 |
| 2 | `www/sw.js` | `const CACHE = 'invoice-pdf-vN'` (line 2) | v64 |
| 3 | `updates/latest.json` | `"version": "1.0.N"` | 1.0.28 |

Rules:
- **Every push to GitHub must bump APP_VERSION and SW cache** — otherwise the PWA won't update for users
- The OTA bundle version (`updates/latest.json`) is only bumped when you generate and deploy a new bundle.zip (see OTA section below)
- Don't forget to regenerate `updates/bundle.zip` when the OTA version is bumped

---

## File Structure

```
mcnichol-invoices/
├── www/                          ← Web source (deployed to GitHub Pages)
│   ├── index.html                ← ENTIRE app — ~6,000 lines, single file, no build step
│   ├── sw.js                     ← Service worker (cache-first, never-cache for Firebase/OTA)
│   ├── manifest.json             ← PWA manifest
│   └── AUDIT-*.md                ← Audit reports (don't delete, historical reference)
├── android/                      ← Capacitor Android project (committed to git)
│   └── app/src/main/java/com/banksiasprings/invoices/
│       ├── MainActivity.java     ← Registers NativeGeoPlugin, extends BridgeActivity
│       ├── NativeGeoPlugin.java  ← Custom Capacitor plugin for native geofencing
│       └── GeofenceBroadcastReceiver.java  ← Fires even when app is dead
├── updates/                      ← OTA update bundles (served via GitHub Pages)
│   ├── latest.json               ← {"version": "1.0.N", "url": "...bundle.zip"}
│   └── bundle.zip                ← Zipped www/ folder for OTA delivery
├── capacitor.config.json         ← Capacitor config (package id, OTA URL, plugin config)
├── package.json                  ← npm/Capacitor dependencies
├── build_apk.sh                  ← Debug APK build script
├── run_gradle_release.sh         ← Release AAB build script
├── mcnichol-release.keystore     ← NEVER COMMIT — signing key (.gitignored)
├── keystore.properties           ← NEVER COMMIT — signing credentials (.gitignored)
└── InvoicePDF-latest.apk         ← Output of debug build (.gitignored)
```

---

## Architecture: Single-File PWA + Capacitor Wrapper

**The entire app lives in `www/index.html`** — no build step, no webpack, no separate JS files.
All JavaScript is inline. This is intentional — keeps deployment simple (push → Pages → done).

When running in the APK, Capacitor injects `window.Capacitor` and native plugins become
available via `window.Capacitor.Plugins`. The `initCapacitorBridge()` IIFE (near the bottom
of index.html) checks `window.Capacitor.isNativePlatform()` and no-ops in the browser.

### Key Subsystems

**DB** — localStorage wrapper
```js
var DB = { get(key), set(key, val) }  // 'var' not 'const' — must attach to window
```
All app data lives in localStorage. Firestore is a mirror/backup, not the source of truth.

**CloudSync** — Firestore sync
- Writes a single JSON blob per user to Firestore on every save
- `CloudSync.restore()` pulls from Firestore only on first sign-in (guarded by `_sessionInit` flag)
- DO NOT make restore() pull on every auth token refresh — this caused catastrophic data loss (v12 fix)

**GeoLog** — Diagnostic log
- localStorage key: `mcn_geoLog`
- Ring buffer, max 200 entries
- Entry format: `{ ts, time, date, type, detail }`
- Types: `enter`, `exit`, `start`, `stop`, `ignore`, `error`, `info`
- Rendered in Settings → Geo Diagnostics tab
- Always add GeoLog entries for significant geo/timer events — this is the only debugging tool

**Timer** — `setInterval` + `activeDay` localStorage record
- `activeDay()` returns the current day record (or null)
- `timerInterval` is the `setInterval` handle for the display
- `autoStartTimer(site, overrideTime)` creates the `activeDay` record
- `autoStopTimer(overrideTime)` sets `ad.finish` and shows the review screen
- `saveDay()` moves `activeDay` to the `days` array and clears `activeDay`
- NEVER key entries by date alone — use `id: Date.now().toString(36) + random` to avoid same-day collisions

---

## Geofencing: Two Completely Different Pathways

This is the most misunderstood part of the app. Read carefully.

### Pathway 1: Web GPS (browser/PWA only)
- `startGPS()` → `navigator.geolocation.watchPosition()`
- `startBgPoll()` → `getCurrentPosition()` every 90 seconds (backup)
- **DIES when screen goes off or browser is backgrounded — this is a hard browser limitation**
- Both feed into `checkNearbySites(lat, lng)` which does haversine distance checks
- Auto-start fires: inside geofence + no active day + hours 5am–9pm
- Auto-stop fires: outside geofence for 5 minutes (debounce timer) + active day + hours

### Pathway 2: Native Android Geofencing (APK only)
Managed by `initCapacitorBridge()` → `initNativeGeo()`:

**Registration:** `NativeGeoPlugin.registerSites({ sites })` → `GeofencingClient.addGeofences()`
- Re-registers whenever sites change (`window.onSitesChanged`)
- Each site becomes a circular geofence (default radius 150m, matches site.radius field)
- Geofences persist across app restarts and phone reboots

**Event delivery:** `GeofenceBroadcastReceiver.onReceive()`
- Fires even when the app process is completely dead
- Saves `{ site, type: 'enter'|'exit', time, date, timestamp }` to SharedPreferences
- Sends a push notification immediately
- Hour guard (5am–9pm) checked here too

**Event processing:** `processPendingGeoEvents()` in JS
- Reads from SharedPreferences via `NativeGeo.getPendingEvents()`
- Runs on: app cold open (1.5s after `initApp()`), app resume from background
- Replays events in order, calling `autoStartTimer(site, ev.time)` or `autoStopTimer(ev.time)`
- `overrideTime` ensures the recorded time is when the event actually fired, not when app opened

**Key behaviour:** Timer start/stop times are RETROACTIVELY set to when the native event fired.
If you arrived at 07:30 and open the app at 09:00, the timer records 07:30 as the start.
The push notification at 07:30 is the real-time confirmation.

### Geofence Flags (prevent duplicates)
```js
let geoAutoStartTriggered = false;  // in-memory, resets on app kill
let geoAutoStopTriggered = false;   // in-memory, resets on app kill
let geoAutoStartDate = null;        // YYYY-MM-DD of last trigger
let geoAutoStopDate = null;
```
These are reset only when `geoAutoXxxDate !== todayStr()` on resume.
Protection against duplicate start: `activeDay()` check. Protection against duplicate stop: `geoAutoStopTriggered` flag.

### Exit Debounce
- Web GPS: 5-minute debounce (`GEO_STOP_DEBOUNCE = 5 * 60 * 1000`)
- Native: queued events older than 5 minutes apply immediately after a fresh GPS verify; newer events start the 5-minute debounce
- Both paths get a fresh GPS fix before stopping, to discard boundary flutter

---

## OTA Updates (APK Only)

The APK uses `@capgo/capacitor-updater` to update the web code without releasing a new APK.

**How it works:**
1. App starts → updater checks `https://banksiasprings.github.io/tradie-invoices/updates/latest.json`
2. If version in `latest.json` > currently installed version → downloads `bundle.zip`
3. Bundle is extracted and the new `www/` content is used from next launch
4. The SW never-cache list includes `/updates/latest.json` and `/updates/bundle.zip` to ensure they're always fresh

**SW never-cache list** (in `www/sw.js`) — these URLs MUST NOT be served from cache:
- All Firebase/Firestore/auth domains
- `/updates/latest.json`
- `/updates/bundle.zip`

**To deploy an OTA update (for APK users):**
```bash
cd ~/Documents/mcnichol-invoices
# 1. Bump version in latest.json (e.g., "1.0.28" → "1.0.29")
# 2. Zip the www/ folder
zip -r updates/bundle.zip www/
# 3. Commit and push (this deploys via GitHub Pages)
git add updates/ www/ && git commit -m "..." && git push
```

Do NOT need to rebuild the APK for web-only changes — OTA handles it.

---

## Data Model

### localStorage Keys
| Key | Type | Description |
|---|---|---|
| `mcn_settings` | Object | Business settings (rate, client, trade type, etc.) |
| `mcn_sites` | Array | Job sites with name, lat, lng, radius, client |
| `mcn_clients` | Array | Clients with company, ABN, address, email |
| `mcn_activeDay` | Object | Current active day record (null when idle) |
| `mcn_days` | Array | All completed day records |
| `mcn_geoLog` | Array | GeoLog entries (200-entry ring buffer) |
| `mcn_geoFlags` | (not yet) | Proposed: persist geo trigger flags |
| `gst_on` | Boolean | GST toggle state |

### activeDay Record
```js
{
  id: "timestamp36random",   // unique ID — NEVER use date as key
  site: "Site Name",
  start: "07:30",            // HH:MM
  finish: "15:30",           // HH:MM — set by autoStopTimer or finishDay
  date: "2026-05-07",
  rate: 55,
  sonWorking: false,
  sonHours: null,
  sonrate: 30,
  lunchMins: 0,
  lunchStart: null,          // HH:MM if currently on lunch
  machines: [],
  autoStarted: true          // set by autoStartTimer (not finishDay)
}
```

---

## UI Design System

Colors:
- `--navy: #1C2A44` — headers, nav bar, primary dark
- `--amber: #C1583A` — CTAs, key figures, accents
- `--bg: #F8F4ED` — warm cream background
- `--surface: #FFFFFF` — cards
- Dark mode fully supported via `.dark` class and `prefers-color-scheme:dark`

Fonts: Montserrat (headings, 800 weight) + Inter (body) via Google Fonts

Nav: Fixed bottom bar with 5 tabs (Check-in, Log, Invoice, Manual, Settings).
Each tab is a `<div class="screen">` shown/hidden by `showScreen(id)`.

---

## APK Details

- **Package:** `com.banksiasprings.invoices`
- **Capacitor version:** 8.x
- **Min SDK:** Android 8.0 (API 26)
- **Target SDK:** Android 14 (API 34)
- **Signing keystore:** `~/Documents/mcnichol-invoices/mcnichol-release.keystore`
  - Password: stored in `keystore.properties` (gitignored)
  - Alias: `mcnichol-key`
- **Debug APK output:** `~/Documents/mcnichol-invoices/InvoicePDF-latest.apk`
- **Release AAB output:** `android/app/build/outputs/bundle/release/app-release.aab`

### Build Commands
```bash
# Debug APK (for testing):
bash ~/Documents/mcnichol-invoices/build_apk.sh

# Release AAB (for Play Store):
bash ~/Documents/mcnichol-invoices/run_gradle_release.sh

# IMPORTANT: Always run `npx cap sync android` first if www/ changed
# (syncs web assets into android/app/src/main/assets/public/)
```

### Required Before Building
1. `npx cap sync android` — copies www/ into Android assets
2. Java: `/Applications/Android Studio.app/Contents/jbr/Contents/Home`
3. Android SDK: `~/Library/Android/sdk`

### Registered Capacitor Plugins
- `@capacitor/local-notifications` — in-app push notifications (arrival/departure)
- `@capacitor-community/background-geolocation` — fallback if NativeGeo unavailable
- `@capgo/capacitor-updater` — OTA web bundle updates
- `@capacitor/filesystem` — PDF file save
- `@capacitor/share` — PDF sharing
- `NativeGeoPlugin` (custom Java, registered in MainActivity.java) — primary geofencing

---

## Coding Rules

### Think Before Touching
- State assumptions. If uncertain, say so first.
- Read the relevant section of index.html before editing it — context matters.
- Push back if a simpler solution exists.

### Surgical Changes Only
- Touch ONLY what the request requires. Do not "improve" adjacent code.
- Match existing style — everything is minified/compressed by habit.
- Every changed line must trace directly to the user's request.

### Version Bumps Are Mandatory
- Bump APP_VERSION + SW cache on every code change — always, no exceptions.
- Include both version numbers in the completion message.

### Geofencing: Don't Break the Architecture
- Web GPS and Native Geo are SEPARATE pathways — changes to one must not break the other
- `initCapacitorBridge()` wraps native-only code in `isNativePlatform()` guard
- `processPendingGeoEvents()` must remain idempotent — called multiple times per session
- Never remove the `geoAutoStartTriggered` / `geoAutoStopTriggered` guards
- Always use `overrideTime` when replaying queued events — never `nowTime()` for replays

### Data Safety
- The `id` field on day records prevents same-day collisions — never key by date alone
- `CloudSync.restore()` must only run on first sign-in (`_sessionInit` guard)
- localStorage is the source of truth; Firestore is backup/sync

### GeoLog
- Always `GeoLog.add(type, detail)` for significant geo/timer events
- Use the correct type: `enter`, `exit`, `start`, `stop`, `ignore`, `error`, `info`
- The log is the only debugging tool available in production

---

## Git Workflow

```bash
# All git via osascript — don't use the Bash tool directly for git
# Clear lock files if needed first:
rm -f ~/Documents/mcnichol-invoices/.git/index.lock

# Standard commit:
cd ~/Documents/mcnichol-invoices
git add www/index.html www/sw.js [other files]
git commit -m "fix: description (vN)"
git push origin main
```

GitHub Pages deploys in ~20-25 seconds after push.
The site serves from the `www/` subfolder — `path: 'www'` in the Actions config.

---

## Known Bugs Fixed (Don't Reintroduce)

### autoStopTimer double nowTime() [FIXED v64]
Original code called `nowTime()` twice — once for GeoLog, once for `ad.finish`.
If a minute boundary fell between them, the log showed a different time than the saved record.
**Fix:** Single `const stopTime = overrideTime || nowTime()` used for both.

### initCheckinScreen restarts timer when day already finished [FIXED v64]
If the day was auto-stopped while the app was closed, reopening the app called
`showActiveTimer(ad)` even though `ad.finish` was set — restarting the timer display.
**Fix:** `if(ad && ad.finish) showReview(ad); else if(ad) showActiveTimer(ad);`

### CloudSync.restore() overwrote local data on every token refresh [FIXED v12]
Firestore restore ran every time `onAuthStateChanged` fired (every ~60min token refresh).
This overwrote local settings with stale Firestore data.
**Fix:** `_sessionInit` flag prevents re-running restore after first sign-in.

### const DB → var DB [FIXED early]
`const DB` doesn't attach to `window`, breaking Firestore sync which expected `window.DB`.
**Fix:** Changed to `var DB`.

### Data loss on Chrome clear [INCIDENT 2026-04-08]
Steven cleared Chrome data, losing all localStorage. Nothing was in Firestore at the time.
He re-entered all data. Firestore now has real data and is the backup.
This is why `CloudSync.pushAll()` is called in saveSettings, saveDay, and saveManualEntry.

---

## Known Issues (Not Yet Fixed)

### geoAutoStartTriggered not persisted [FIX-3]
In-memory flag — resets on app kill. Could cause duplicate auto-start on same-day app restart.
Mitigation: `activeDay()` check prevents re-starting if timer already running.
Recommended fix: persist to localStorage with date key `mcn_geoFlags`.

### Arrival/departure notification guards not persisted [FIX-4]
`_lastArrivalNotifyDate` and `_lastDepartureNotifyDate` are in-memory.
Resets on kill → could send duplicate push notification on same-day restart.
Recommended fix: same localStorage pattern.

### Lunch duration wrong during overrideTime stop [FIX-5]
If `lunchStart` is set and `autoStopTimer(overrideTime)` is called, the lunch minutes
calculation uses `new Date()` (current time) not the replayed stop time.
Low risk — would need user to leave lunch running then close app.

---

## Play Store

- **Package name:** `com.banksiasprings.invoices`
- **Signed AAB versionCode 2 / v1.1:** `android/build/android/app/outputs/bundle/release/app-release.aab`
- **Play Store icon 512px:** `play-store-assets/icon-512-playstore.png`
- **Feature graphic 1024×500:** `play-store-assets/feature-graphic-1024x500.png`
- **Store listing:** `play-store-listing.md`
- **Privacy policy:** `https://banksiasprings.github.io/tradie-invoices/privacy.html`

---

## Future Plans (Don't Build These Without Being Asked)

- **Employee timesheets** — employees on own phones, hours sync to owner's invoice
- **Xero integration** — push invoices to Xero
- **Geo flag persistence** — FIX-3 and FIX-4 above
- **Background event UX** — toast on app open showing what was detected in background
