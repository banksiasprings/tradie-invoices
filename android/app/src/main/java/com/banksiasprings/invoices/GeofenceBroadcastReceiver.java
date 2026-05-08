package com.banksiasprings.invoices;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
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
    private static final String CHANNEL_ID = "geofence_channel";
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

        // Current time
        long now = System.currentTimeMillis();
        SimpleDateFormat timeFmt = new SimpleDateFormat("HH:mm", Locale.getDefault());
        SimpleDateFormat dateFmt = new SimpleDateFormat("yyyy-MM-dd", Locale.getDefault());
        String timeStr = timeFmt.format(new Date(now));
        String dateStr = dateFmt.format(new Date(now));

        // Only act between 05:00 and 21:00
        int hour = Integer.parseInt(timeStr.substring(0, 2));
        if (hour < 5 || hour >= 21) {
            Log.d(TAG, "Geofence event outside active hours (" + timeStr + ") — ignoring");
            return;
        }

        // Save each triggered fence as a pending event
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

        // Fire a notification so the user knows what was detected
        for (Geofence fence : fences) {
            String siteName = fence.getRequestId();
            String title = type.equals("enter") ? "Arrived at " + siteName : "Left " + siteName;
            String body = type.equals("enter")
                    ? "Timer started at " + timeStr + ". Open app to review."
                    : "Timer stopped at " + timeStr + ". Open app to generate invoice.";
            sendNotification(context, title, body, type.equals("enter") ? 100 : 101);
        }
    }

    private void sendNotification(Context context, String title, String body, int notifId) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Site Arrival/Departure", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Notifies when you arrive at or leave a job site");
            nm.createNotificationChannel(ch);
        }

        // Tap notification → open app
        Intent launch = new Intent(context, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                context, notifId, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pi);

        nm.notify(notifId, builder.build());
    }
}
