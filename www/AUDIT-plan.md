# Fix Plan — Invoice App Audit

**Priority order** | 6 items total | 2 done, 4 queued for future sprints

---

## ✅ Done (v64, this audit)

### FIX-1: autoStopTimer log/record time mismatch
- **File:** `www/index.html` ~line 2772
- **Change:** Single `stopTime` variable replaces two separate `nowTime()` calls
- **Risk:** Zero — purely defensive, no behaviour change in the normal case

### FIX-2: initCheckinScreen restarts timer when day already finished
- **File:** `www/index.html` ~line 2841
- **Change:** Check `ad.finish` before calling `showActiveTimer` vs `showReview`
- **Risk:** Low — only fires when `activeDay` has a finish time set (auto-stop background replay path)

---

## 🔶 Next Sprint (recommended before next APK release)

### FIX-3: Persist geo trigger flags to localStorage
- **File:** `www/index.html` ~line 2579
- **Why:** `geoAutoStartTriggered` / `geoAutoStopTriggered` reset on app kill/restart, risking
  duplicate auto-start or duplicate notifications on same-day app restart
- **How:** Add `loadGeoFlags()` / `saveGeoFlags()` using localStorage key `mcn_geoFlags` with
  `{date, started, stopped}` — load on init, save after setting each flag

### FIX-4: Persist arrival/departure notification date guards
- **File:** `www/index.html` ~line 2747
- **Why:** `_lastArrivalNotifyDate` and `_lastDepartureNotifyDate` reset on app kill, causing
  duplicate push notifications when background event replay fires on same day as original event
- **How:** Same pattern as FIX-3 — persist to localStorage with date key

---

## 🔵 Future / Low Priority

### FIX-5: Lunch duration calculation in replayed autoStopTimer events
- **File:** `www/index.html` ~line 2777
- **Why:** If `lunchStart` is set and `overrideTime` is provided (event replay), lunch duration
  is calculated from `new Date()` (now) not from the replayed stop time
- **How:** Parse `overrideTime` into a Date object for lunch calculation; see `AUDIT-full-code-review.md` ISSUE-3

### FIX-6: UX — Show background geo status to user
- **Files:** `www/index.html` (checkin screen header + event replay UI)
- **Why:** Users don't know whether native geofencing is active or not; if app is in background
  and an event fires, there's no visible confirmation until the app is opened
- **Suggestions:**
  - Toast on startup: "Detected: Hillside 07:30–15:30 — timer applied" when pending events found
  - "Background: ON" / "Background: OFF" badge in check-in header
  - GeoLog tab badge count in nav when there are recent errors

---

## Architectural Note: Background Timer Reality

The native Android APK geofencing **does work** in the background. When the user arrives
or leaves a site with the app closed:
1. Android fires the geofence event
2. `GeofenceBroadcastReceiver` saves the event (with correct time) to SharedPreferences
3. A push notification fires immediately on the user's phone
4. When the user next opens the app, the event is replayed with the original timestamp

**What doesn't work in the background:**
- Web GPS (PWA/Chrome only)
- The timer display (it can't tick while the app is closed — this is expected JS behaviour)
- Any UI updates (also expected)

The user sees "timer not running" because the display is frozen, but the record is correct
when the app is opened. This is correct behaviour for a PWA, and good behaviour for the APK.
The main gap is communication — the user needs to understand what happened.
