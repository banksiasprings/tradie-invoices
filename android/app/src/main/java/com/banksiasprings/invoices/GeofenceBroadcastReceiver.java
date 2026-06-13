package com.banksiasprings.invoices;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.util.Log;

import androidx.localbroadcastmanager.content.LocalBroadcastManager;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingEvent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class GeofenceBroadcastReceiver extends BroadcastReceiver {

    private static final String TAG = "GeofenceReceiver";
    private static final String PREFS_NAME = "native_geo_prefs";
    private static final String EVENTS_KEY = "pending_events";

    /**
     * Fused-location fixes worse than this are not trustworthy for a fence
     * decision (default fence radius is 150m). Rural wifi/cell positioning can
     * be kilometres off; without this gate those fixes fire fences "randomly".
     * Rejected events are still persisted + forwarded so the GeoLog shows them,
     * but carry rejected:true and JS never acts on them.
     */
    private static final float ACC_REJECT_M = 150f;

    /**
     * DEBUG BUILDS ONLY: lets the emulator test harness drive the full receiver
     * pipeline (hour guard → enrichment → accuracy gate → persist → broadcast)
     * with synthetic positions/accuracies that GMS + `adb emu geo fix` cannot
     * produce (e.g. a 400m-accuracy fix to exercise the rejection gate).
     * GeofencingEvent needs GMS parcelables, so it can't be faked from shell —
     * this action takes plain extras instead. Stripped from release builds.
     */
    private static final String TEST_ACTION = "com.banksiasprings.invoices.TEST_GEO_EVENT";

    @Override
    public void onReceive(Context context, Intent intent) {
        String type;
        String testSite = null;
        Location trigLoc = null;

        // Debuggable check at runtime (AGP 8 doesn't generate BuildConfig by default)
        boolean debuggable = (context.getApplicationInfo().flags
                & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable && TEST_ACTION.equals(intent.getAction())) {
            testSite = intent.getStringExtra("site");
            type = intent.getStringExtra("type");
            if (testSite == null || type == null) return;
            if (intent.hasExtra("lat")) {
                trigLoc = new Location("test");
                trigLoc.setLatitude(Double.parseDouble(intent.getStringExtra("lat")));
                trigLoc.setLongitude(Double.parseDouble(intent.getStringExtra("lng")));
                trigLoc.setAccuracy(Float.parseFloat(intent.getStringExtra("acc")));
                trigLoc.setTime(System.currentTimeMillis());
            }
            Log.d(TAG, "TEST_GEO_EVENT: " + type + " @ " + testSite);
            handleTransition(context, type, java.util.Collections.singletonList(testSite), trigLoc);
            return;
        }

        GeofencingEvent event = GeofencingEvent.fromIntent(intent);
        if (event == null || event.hasError()) {
            Log.e(TAG, "Geofencing event error" + (event != null ? " code=" + event.getErrorCode() : ""));
            return;
        }

        int transition = event.getGeofenceTransition();
        List<Geofence> fences = event.getTriggeringGeofences();
        if (fences == null || fences.isEmpty()) return;

        // DWELL is the entry signal since v81 (30s loiter = anti-flutter).
        // ENTER kept for any fence registered by an older APK still alive in GMS.
        if (transition == Geofence.GEOFENCE_TRANSITION_ENTER
                || transition == Geofence.GEOFENCE_TRANSITION_DWELL) {
            type = "enter";
        } else if (transition == Geofence.GEOFENCE_TRANSITION_EXIT) {
            type = "exit";
        } else {
            Log.w(TAG, "Unknown transition " + transition + " — ignoring");
            return;
        }

        // The location that triggered this transition — THE source of truth the
        // GeoLog was missing. Records where the phone thought it was, how sure
        // it was (accuracy), and how stale the fix was. Events triggered by
        // garbage-accuracy fixes are marked rejected so JS logs but never acts.
        trigLoc = event.getTriggeringLocation();

        List<String> siteNames = new java.util.ArrayList<>();
        for (Geofence fence : fences) siteNames.add(fence.getRequestId());
        handleTransition(context, type, siteNames, trigLoc);
    }

    /** Shared pipeline for real GMS transitions and (debug-only) test events. */
    private void handleTransition(Context context, String type, List<String> siteNames, Location trigLoc) {
        long now = System.currentTimeMillis();
        SimpleDateFormat timeFmt = new SimpleDateFormat("HH:mm", Locale.getDefault());
        SimpleDateFormat dateFmt = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault());
        String timeStr = timeFmt.format(new Date(now));
        String dateStr = dateFmt.format(new Date(now));

        int hour = Integer.parseInt(timeStr.substring(0, 2));
        if (hour < 5 || hour >= 21) {
            Log.d(TAG, "Geofence event outside active hours (" + timeStr + ") — ignoring");
            return;
        }

        // Persist the event for JS to replay. Java MUST NOT fire any user-facing
        // notification — only JS knows whether a raw enter/exit actually
        // translates to a timer start/stop (vs. boundary flutter, ignored
        // duplicate, debounced exit, etc.). Notifications are fired from JS in
        // autoStartTimer() / autoStopTimer() only.
        try {
            android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String existing = prefs.getString(EVENTS_KEY, "[]");
            JSONArray events = new JSONArray(existing);

            for (String siteName : siteNames) {
                JSONObject ev = new JSONObject();
                ev.put("site", siteName);
                ev.put("type", type);
                ev.put("time", timeStr);
                ev.put("date", dateStr);
                ev.put("timestamp", now);

                if (trigLoc != null) {
                    ev.put("evLat", trigLoc.getLatitude());
                    ev.put("evLng", trigLoc.getLongitude());
                    ev.put("acc", Math.round(trigLoc.getAccuracy()));
                    ev.put("fixAgeMs", Math.max(0, now - trigLoc.getTime()));
                    JSONObject site = GeoRegistrar.findSite(context, siteName);
                    if (site != null && site.has("lat") && !site.isNull("lat")) {
                        double d = GeoRegistrar.distMeters(
                                trigLoc.getLatitude(), trigLoc.getLongitude(),
                                site.getDouble("lat"), site.getDouble("lng"));
                        ev.put("distM", Math.round(d));
                    }
                    if (trigLoc.getAccuracy() > ACC_REJECT_M) {
                        ev.put("rejected", true);
                        ev.put("reason", "accuracy " + Math.round(trigLoc.getAccuracy())
                                + "m > " + (int) ACC_REJECT_M + "m");
                    }
                } else {
                    // No triggering location attached — cannot validate. Pass
                    // through (acting beats dropping a real arrival), but flag it.
                    ev.put("acc", -1);
                }
                events.put(ev);
                Log.d(TAG, "Saved geo event: " + type + " @ " + siteName + " at " + timeStr
                        + (trigLoc != null ? " acc=" + Math.round(trigLoc.getAccuracy()) + "m" : " (no trig loc)")
                        + (ev.optBoolean("rejected") ? " REJECTED" : ""));

                // Real-time delivery: send a local broadcast so NativeGeoPlugin can
                // forward the event to JS immediately when the app process is alive
                // (foreground or background). When the process is dead this broadcast
                // is a no-op and the event is recovered from SharedPreferences on next
                // app open via processPendingGeoEvents().
                Intent localIntent = new Intent("com.banksiasprings.invoices.GEO_EVENT");
                localIntent.putExtra("eventJson", ev.toString());
                LocalBroadcastManager.getInstance(context).sendBroadcast(localIntent);
            }

            prefs.edit().putString(EVENTS_KEY, events.toString()).apply();

        } catch (Exception e) {
            Log.e(TAG, "Error saving geo event", e);
        }
    }
}
