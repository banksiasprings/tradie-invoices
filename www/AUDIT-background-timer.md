# AUDIT: Background Timer Start/Stop

**Complaint:** "App won't start or stop unless app is open"  
**Status:** Partially architectural; one bug fixed in v64

---

## Architecture Overview

The app has two geofencing pathways:

### 1. Web GPS (PWA / Chrome browser)
- `startGPS()` calls `navigator.geolocation.watchPosition()` — fires while the browser is active
- `startBgPoll()` polls `getCurrentPosition()` every 90 seconds as a fallback
- **Both die the moment the screen goes off or Chrome is backgrounded**
- Auto-start and auto-stop via web GPS only work when the phone screen is on and the app is open/visible

### 2. Native Android Geofencing (APK only)
- `NativeGeoPlugin` (Java/Capacitor) registers site geofences with `GeofencingClient`
- `GeofenceBroadcastReceiver` fires even when the app process is completely dead
- On geofence event: saves `{site, type, time, timestamp}` to SharedPreferences; fires a local push notification immediately
- JS processes these queued events via `processPendingGeoEvents()` — which runs on:
  - App cold open (1.5 s after `initApp()` via `initNativeGeo()`)
  - App resume from background (`resume` event)

### What This Means in Practice

| Scenario | Web GPS (PWA) | Native Android (APK) |
|---|---|---|
| Screen on, app visible | ✅ Works | ✅ Works |
| Screen on, app backgrounded | ❌ Stops | ✅ Works |
| Screen off | ❌ Stops | ✅ Works |
| Phone off / app killed | ❌ Stopped | ✅ Events queued in SharedPreferences |

**The APK native geofencing does work in the background.** Timer start/stop times are
retroactively set to the actual arrival/departure times (from the queued events), not the
time the app was opened. The push notification confirms the event immediately.

---

## Bug Found and Fixed: Review Screen Not Shown on Reopen (v64)

**Original `initCheckinScreen()` code:**
```js
const ad = activeDay();
if (ad) showActiveTimer(ad);    // always shows active timer — even if day has ad.finish set!
```

**Scenario that breaks it:**
1. App is closed; user arrives at site → native ENTER fires → queued in SharedPreferences
2. User leaves site → native EXIT fires → also queued
3. User opens app the next morning:
   - `initCheckinScreen()` runs — `activeDay()` is null (no data yet) → idle screen shown ✓
   - 1.5s later `processPendingGeoEvents()` runs:
     - ENTER event: `autoStartTimer(site, '07:30')` → sets `activeDay` in DB → `showActiveTimer(ad)` ✓
     - EXIT event: `autoStopTimer('15:30')` → sets `ad.finish = '15:30'` → `showReview(ad)` ✓
   - This actually works correctly in the multi-event path above

**Alternative scenario that was broken:**
1. User arrives at site with app open → web GPS fires → `autoStartTimer()` → timer ticking ✓
2. User presses Home, screen goes off
3. Web GPS dies — native geofencing takes over → EXIT queued in SharedPreferences
4. User closes the app completely (swipes away)
5. User reopens the app (same day):
   - `initCheckinScreen()` → `activeDay()` returns the day (still no `finish`) → `showActiveTimer(ad)` ✓
   - `processPendingGeoEvents()` → EXIT event → `autoStopTimer('15:30')` → sets `ad.finish` → `showReview(ad)` ✓
6. User dismisses review and navigates away without saving
7. User taps Check-in tab again → `initCheckinScreen()` → `activeDay()` still has `ad.finish = '15:30'`
   - Old code: `showActiveTimer(ad)` → **restarts the timer ticking from 15:30 to now (wrong!)**
   - **Fixed code:** `if(ad && ad.finish) showReview(ad); else if(ad) showActiveTimer(ad);`

**Fix applied in v64:** `initCheckinScreen` now checks `ad.finish` before deciding which view to show.

---

## Why the User Sees "Timer Not Starting"

**Most likely cause:** Using the PWA (browser) on Android, not the APK. In this case:
- No native geofencing → completely dependent on web GPS
- Web GPS dies when screen goes off → no background detection at all
- Must keep the app open and screen on to get auto-start/stop

**If using the APK:** The timer IS starting and stopping correctly in the background — events
are queued and replayed. The user may not realise this because there's a 1.5s delay before
events process on app open, and the timer display briefly shows either 0 or the idle screen
before jumping to the review.

---

## Recommendations

1. **Add a "Background mode: ON / OFF" indicator** in the Check-in header showing whether
   native geofencing is active (APK) or web-only (PWA).
2. **Add a "Last background event" banner** on the check-in screen showing the most recent
   GeoLog entry — gives the user confidence that the background system is working.
3. **Consider a startup splash/toast** when pending geo events are found: "We detected you
   were at Hillside from 07:30–15:30 — timer has been applied."
