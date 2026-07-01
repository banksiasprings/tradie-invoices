# IDEAS — v90 geofence precision (post-test backlog)

> Steven's ideas, captured 2026-06-30 during the live field test. **Do NOT build
> until today's basic auto-trigger data is validated** — we need to confirm the
> v89 fundamentals work in the field before stacking precision on top.

---

## 1. Concentric geofences (outer "wake" ring + inner "event" ring)

Register **two** fences per site via Android `GeofencingClient` (registering
multiple geofences is free — GMS monitors them in its own process, no extra app
battery cost):

- **Outer ring** at `radius + 1000m` → on transition, switch the app into
  **high-frequency poll / wake mode** (tighten the location request interval).
- **Inner ring** at the current `radius` → this is the **canonical ENTER/EXIT
  event** that starts/stops the timer.

**Why:** battery-friendly when far from site (no high-rate polling), precise when
close (high-rate only inside the outer ring). The outer ring is a cheap "he's
nearly here, pay attention" trigger.

**Implementation notes:**
- Build both fences in `GeoRegistrar.buildGeofence()` (one extra fence per site,
  requestId suffix e.g. `<site>__outer`).
- Outer-ring DWELL/ENTER → JS bumps the foreground/bg poll cadence; outer EXIT →
  relax it.
- Inner ring keeps the existing DWELL(30s)|EXIT semantics and remains the only
  thing that calls `autoStartTimer` / `_confirmDepartureThenStop`.
- Keep it idempotent with the v81 persisted flags; don't let the outer ring ever
  start/stop the timer.

## 2. Time interpolation between polls (sub-30s crossing time)

When ENTER/EXIT fires, don't stamp it at the poll instant — **interpolate the
real boundary-crossing time** from the two fixes that straddle the boundary:

- Last fix **outside**: time `T1`, distance-from-boundary `D1`.
- First fix **inside**:  time `T2`, distance-from-boundary `D2`.
- `crossing_time = T1 + (T2 - T1) * (D1 / (D1 + D2))`
- Back-date the ENTER/EXIT (and therefore the timer start/finish) to
  `crossing_time`.

**Why:** turns a coarse "somewhere in the last poll window" into a <30s estimate
on most arrivals — tighter than the native DWELL/replay timing.

**Caveat:** assumes straight-line motion between the two fixes. Curved roads /
speed changes add error — bound it (e.g. ignore interpolation if the two fixes
are > N minutes apart, or if implied speed is implausible) and fall back to the
fix timestamp. Pairs naturally with idea #1 (the outer ring guarantees a dense
set of fixes near the boundary to interpolate from).

---

*Both ideas are precision improvements on top of v89's reliability fix. Sequence:
validate v89 in the field → then layer #1 (cheap, structural) → then #2 (uses the
denser fixes #1 provides).*

---

# ⭐ HIGHEST PRIORITY — found during the 2026-06-30 field test

Field evidence (app fully swiped-closed): the geofence DID fire and Android woke
the dead app process at 07:42:51 (`ActivityManager: Start proc … for broadcast
{GeofenceBroadcastReceiver}`), and the receiver banked `enter @ Lucas Ranch 07:42`
to the native queue. But **no notification, no timer, no Firestore** — because all
of that is fired by the **JS layer, which never loads when there's no Activity/
WebView**. The app is fully battery-whitelisted + standby-EXEMPTED + background-
allowed, so this is NOT a doze/settings problem — it's the Capacitor architecture.

## 3. Native event-queue drainage — the ACTUAL fix for the closed-app bug

Move geofence handling out of JS into a native Android **Service / WorkManager**
that runs the moment the `GeofencingClient` broadcast fires, with NO dependency on
the WebView:
- Receiver (already fires when dead) → start a short-lived **foreground Service**
  (`FOREGROUND_SERVICE_LOCATION`, already declared) or enqueue an expedited
  WorkManager job.
- It reads the sites from SharedPreferences (already mirrored there by
  `GeoRegistrar`), applies the v89 stop-confirmation rules natively, **starts the
  timer state + posts the arrival/departure notification IMMEDIATELY** — no JS.
- Persist the day/event to a local store (Room DB, or keep the existing SharedPrefs
  queue + a `timer_state` record).
- **JS becomes a read/repair layer**: on app open it reconciles its localStorage
  with the native-written state instead of being the thing that creates it.
- This is the idiomatic Android background-location pattern (Strava / Life360 style)
  and is the real cure for "nothing happens until I open the app."
- Migration care: keep the existing JS replay path as a fallback during rollout;
  dedupe so native + JS can't both start/stop (extend the v81 persisted flags into
  the native layer).

## 4. Self-diagnostic settings health flow (Steven, verbatim)

> "I need the app to basically test that all the settings are correct itself…
> there's way too much potential for human error if you're relying on the person
> to know what to do."

A **SettingsHealth** check that runs on app startup AND before every "Start shift".
For each item, PASS/FAIL with a one-tap deep-link to the exact settings page:
- POST_NOTIFICATIONS granted
- ACCESS_FINE_LOCATION + ACCESS_BACKGROUND_LOCATION ("Allow all the time")
- Battery optimisation whitelist (`PowerManager.isIgnoringBatteryOptimizations`)
- Doze / App-Standby bucket (warn if not exempt)
- Manufacturer killers — branch on `Build.MANUFACTURER` (Motorola "Adaptive
  Battery"/app-standby, Samsung, Xiaomi, Oppo…) and deep-link their kill-list pages
- Google Play services version (Geofencing API needs a recent GMS)
- RECEIVE_BOOT_COMPLETED registered (fences survive reboot)
- FOREGROUND_SERVICE_LOCATION declared (Android 14+)

Each FAIL → a big "❌ NEEDS FIXING" card + "Tap to open settings" using the right
Intent (`ACTION_APPLICATION_DETAILS_SETTINGS`,
`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`, etc.). **Block "Start shift" while
any critical check fails** and show the actionable list. Removes the human-error
surface entirely.

*Priority order: #3 (native drainage — fixes the actual closed-app bug) is the big
one; #4 (self-diagnostic) hardens the setup so field failures are self-evident.
#1/#2 (precision) come after the closed-app path is solid.*

---

# ⭐⭐ FLAGSHIP — the "set and forget" architecture (field test 2026-06-30)

## 5. Multi-session unconfirmed queue

**Problem (Steven, verbatim):**
> "It can only keep one set at a time. Let's just say someone went to work three days
> in a row, never opened the app, never looked at the app — there's no way to record
> three sets of logs… you have to confirm them before you start the next one. I want
> the app to be set and forget — install the app, you go to work, you come home, it's
> gonna log everything properly: three days, four days, a week in a row, a fortnight."

Today's single `activeDay` can hold exactly ONE session; a second arrival before the
first is confirmed/saved would collide. Set-and-forget needs a QUEUE.

**Data model change:**
- Replace the single `activeDay` global with an array `unconfirmedSessions[]`.
- Each `WorkSession`: `{ id, site_id, start_time, end_time, status, gps_trace, lunch,
  rate, extra_labourer, notes, edited_by_user }`.
- `status` enum: `UNCONFIRMED` (default) | `CONFIRMED` | `REJECTED` | `MERGED`.
- Only `CONFIRMED` sessions flow into billing / invoice / stats — unconfirmed are
  preserved indefinitely (never auto-discarded).

**Geofence handler changes:**
- ENTER → INSERT a new UNCONFIRMED session with `start_time`.
- EXIT (after the v89 accuracy/fresh-fix check passes) → UPDATE that session's `end_time`.
- Multiple unconfirmed sessions co-exist — arrivals NEVER block on a prior unconfirmed one.

**UI changes:**
- Today tab → shows the latest unconfirmed session.
- Log tab → a "Review Backlog (N)" header with the count of unconfirmed sessions;
  each row gets three big buttons: **Confirm / Adjust / Reject**.
- Invoice + Stats → count CONFIRMED sessions only.

**Edge cases:**
1. **Same-day rejoin (off-site lunch):** if the next ENTER at the same site is within
   `MERGE_WINDOW_MINUTES` (default 90, configurable) of the previous EXIT → MERGE into
   one session with a lunch break; otherwise a separate session.
2. **Multi-site day:** each site gets its own independent session record.
3. **Reboot mid-session:** rely on Room DB persistence (same as today's single-session
   model — BootReceiver already re-registers fences).
4. **After-the-fact edits:** allowed, but stamp `edited_by_user: true` for audit.

**Migration:** existing finalized day records → `CONFIRMED`. No data loss.

**Sequencing note:** this pairs naturally with #3 (native drainage) — the native service
that processes geofences without JS should write into this `unconfirmedSessions[]` queue
directly, which is exactly what makes "never open the app for a fortnight" work. Build
#3 + #5 together; they're the same architectural shift (native owns capture, JS owns
review/confirm).

## 6. Settings → "Round to nearest 15 min" toggle

A Settings toggle that, when ON, rounds all start/end times to the nearest :00/:15/:30/:45.
Reason: matches how Steven actually invoices. **Field-proven need:** on 2026-06-30 the
auto-timer recorded start 07:42 / finish ~19:10, and Steven manually `saveEdit`-ed it to
**08:00 / 19:00** before saving — i.e. he hand-rounds every day. Automate it.
- Apply at display + save time; keep the raw GPS-derived time in the record (don't lose
  precision — `rawStart`/`rawFinish` alongside the rounded values) so the audit trail and
  any dispute resolution still has the real crossing time.
- Default OFF (some users bill to the minute); per-user setting in `mcn_settings`.
- Plays naturally with #5: round at the Confirm step in the review backlog.
