package com.banksiasprings.invoices;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
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

    @Override
    public void onReceive(Context context, Intent intent) {
        GeofencingEvent event = GeofencingEvent.fromIntent(intent);
        if (event == null || event.hasError()) {
            Log.e(TAG, "Geofencing event error");
            return;
        }

        int transition = event.getGeofenceTransition();
        List<Geofence> fences = event.getTriggeringGeofences();
        if (fences == null || fences.isEmpty()) return;

        String type = (transition == Geofence.GEOFENCE_TRANSITION_ENTER) ? "enter" : "exit";

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

            for (Geofence fence : fences) {
                String siteName = fence.getRequestId();
                JSONObject ev = new JSONObject();
                ev.put("site", siteName);
                ev.put("type", type);
                ev.put("time", timeStr);
                ev.put("date", dateStr);
                ev.put("timestamp", now);
                events.put(ev);
                Log.d(TAG, "Saved geo event: " + type + " @ " + siteName + " at " + timeStr);

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
