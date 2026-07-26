package com.banksiasprings.invoices;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * v101.6 — app-owned foreground service that BANKS GPS fixes for the trip log.
 *
 * WHY THIS EXISTS (the bug it replaces):
 * v100–v101.5 drove trip capture from JS via @capacitor-community/background-
 * geolocation's addWatcher(). That plugin tears down its own foreground service
 * in handleOnDestroy():
 *
 *     protected void handleOnDestroy() { if (service != null) service.stopService(); }
 *
 * Steven's Moto Edge 50 Neo destroys MainActivity the moment the app is
 * backgrounded (already documented in NIGHT_LOG for the v101.5 OTA behaviour:
 * handleOnStop -> "App moved to background" -> onActivityDestroyed immediately).
 * So the trip watcher only ever ran while he was looking at the screen — which
 * is exactly when he is NOT driving. Field telemetry confirmed it: zero
 * auto-detected trips ever, and zero GeoLog entries after each morning's app
 * open, across the whole of July.
 *
 * THE ARCHITECTURE mirrors the geofence layer, which has always survived
 * because it is app-owned and OS-driven, not JS-driven:
 *
 *     native banks raw data to SharedPreferences  ->  JS drains + reconstructs
 *
 * This service is deliberately DUMB. It does not run the trip state machine,
 * does not decide what a trip is, and never touches money or day records. It
 * appends {lat,lng,acc,t} to a bounded ring buffer and nothing else. All the
 * trip logic stays in the JS pure block (detectTripsFromFixes /
 * reconstructTripsFromFixes) where it is unit-tested without a device.
 *
 * Lifecycle: started (not bound), so it outlives the Activity. START_STICKY so
 * Android brings it back after a low-memory kill. BootReceiver restarts it
 * after a reboot, the same way geofences are re-registered.
 */
public class TripLogService extends Service {

    private static final String TAG = "TripLogService";

    // Shares native_geo_prefs with the geofence layer so there is ONE native
    // store for the app and the plugin can read both without extra plumbing.
    static final String PREFS_NAME = "native_geo_prefs";
    static final String FIXES_KEY = "trip_fixes";
    static final String ENABLED_KEY = "trip_logging_on";
    static final String ERROR_KEY = "trip_logging_error";
    static final String STARTED_AT_KEY = "trip_logging_started_at";

    /** Ring-buffer cap. A fix is ~70 bytes of JSON; 4000 covers weeks of
     *  driving and still keeps the SharedPreferences write small. */
    static final int MAX_FIXES = 4000;

    private static final String CHANNEL_ID = "trip_log";
    private static final int NOTIFICATION_ID = 4101;

    // 20s / 25m at high accuracy. The 25m displacement filter is what idles the
    // service when the vehicle is parked. 20s is deliberately denser than the
    // JS sampleMs (30s) so the state machine never starves, and far gentler
    // than the 1s interval the old plugin used.
    private static final long INTERVAL_MS = 20000;
    private static final long FASTEST_MS = 10000;
    private static final float MIN_DISPLACEMENT_M = 25f;

    public static final String ACTION_STOP = "com.banksiasprings.invoices.TRIP_LOG_STOP";

    private FusedLocationProviderClient client;
    private LocationCallback callback;
    private boolean updatesRequested = false;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            setEnabled(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            startForegroundCompat();
        } catch (Exception e) {
            // Android 14+ throws if the location permission is missing when a
            // location-typed FGS starts. Record it so JS can SHOW the user why
            // trip logging is off instead of failing silently — the old JS
            // watcher swallowed every error in `if (error || !location) return`.
            recordError(this, "foreground start failed: " + e.getMessage());
            Log.e(TAG, "startForeground failed", e);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!hasLocationPermission()) {
            recordError(this, "location permission not granted");
            Log.w(TAG, "no location permission — stopping");
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!updatesRequested) {
            try {
                requestUpdates();
                updatesRequested = true;
                clearError(this);
                getPrefs(this).edit()
                        .putLong(STARTED_AT_KEY, System.currentTimeMillis())
                        .apply();
                Log.i(TAG, "trip fix logging started");
            } catch (SecurityException e) {
                recordError(this, "location updates rejected: " + e.getMessage());
                Log.e(TAG, "requestLocationUpdates failed", e);
                stopSelf();
                return START_NOT_STICKY;
            }
        }

        // START_STICKY: if Android kills us for memory, restart with a null
        // intent. onStartCommand handles that (intent == null) as a plain start.
        return START_STICKY;
    }

    private void requestUpdates() throws SecurityException {
        client = LocationServices.getFusedLocationProviderClient(this);
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
                .setMinUpdateIntervalMillis(FASTEST_MS)
                .setMinUpdateDistanceMeters(MIN_DISPLACEMENT_M)
                .setWaitForAccurateLocation(false)
                .build();
        callback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                if (result == null) return;
                for (Location loc : result.getLocations()) {
                    if (loc != null) bankFix(TripLogService.this, loc);
                }
            }
        };
        client.requestLocationUpdates(req, callback, Looper.getMainLooper());
    }

    /**
     * Append one fix to the ring buffer. Keys match the JS fix shape
     * ({lat,lng,acc,t}) so reconstructTripsFromFixes consumes them directly.
     */
    static void bankFix(Context ctx, Location loc) {
        try {
            SharedPreferences prefs = getPrefs(ctx);
            synchronized (TripLogService.class) {
                JSONArray arr;
                try {
                    arr = new JSONArray(prefs.getString(FIXES_KEY, "[]"));
                } catch (Exception e) {
                    arr = new JSONArray();
                }
                JSONObject o = new JSONObject();
                o.put("lat", loc.getLatitude());
                o.put("lng", loc.getLongitude());
                o.put("acc", loc.hasAccuracy() ? (double) loc.getAccuracy() : JSONObject.NULL);
                // Wall-clock time of the fix; falls back to now if the provider
                // gives a zero/absent time (some emulator providers do).
                long t = loc.getTime();
                o.put("t", t > 0 ? t : System.currentTimeMillis());

                JSONArray out;
                if (arr.length() + 1 > MAX_FIXES) {
                    // Drop from the FRONT — oldest fixes are the least useful,
                    // and losing them can only truncate an already-replayed trip.
                    out = new JSONArray();
                    int from = arr.length() + 1 - MAX_FIXES;
                    for (int i = from; i < arr.length(); i++) out.put(arr.get(i));
                } else {
                    out = arr;
                }
                out.put(o);
                prefs.edit().putString(FIXES_KEY, out.toString()).apply();
            }
        } catch (Exception e) {
            Log.e(TAG, "bankFix failed", e);
        }
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Trip log", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps your km logbook running in the background");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        PendingIntent tap = null;
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            tap = PendingIntent.getActivity(this, 0, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle("Trip log")
         .setContentText("Recording your km logbook")
         .setSmallIcon(getApplicationInfo().icon)
         .setOngoing(true)
         .setWhen(System.currentTimeMillis());
        if (tap != null) b.setContentIntent(tap);

        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    @Override
    public void onDestroy() {
        try {
            if (client != null && callback != null) client.removeLocationUpdates(callback);
        } catch (Exception ignored) {}
        updatesRequested = false;
        Log.i(TAG, "trip fix logging stopped");
        super.onDestroy();
    }

    // ── Shared helpers (used by the plugin and BootReceiver) ────────────────

    static SharedPreferences getPrefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS_NAME, 0);
    }

    static boolean isEnabled(Context ctx) {
        return getPrefs(ctx).getBoolean(ENABLED_KEY, false);
    }

    static void setEnabled(Context ctx, boolean on) {
        getPrefs(ctx).edit().putBoolean(ENABLED_KEY, on).apply();
    }

    static void recordError(Context ctx, String msg) {
        getPrefs(ctx).edit().putString(ERROR_KEY, msg).apply();
    }

    static void clearError(Context ctx) {
        getPrefs(ctx).edit().remove(ERROR_KEY).apply();
    }

    /** Start the service and remember the choice so a reboot can restore it. */
    static void start(Context ctx) {
        setEnabled(ctx, true);
        Intent i = new Intent(ctx, TripLogService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
            clearError(ctx);
        } catch (Exception e) {
            // Android 12+ blocks background foreground-service starts outside an
            // allowed case. Record it rather than throwing into a silent void —
            // the Setup Health card reads this and tells the user.
            recordError(ctx, "start blocked: " + e.getMessage());
            Log.e(TAG, "startForegroundService failed", e);
        }
    }

    static void stop(Context ctx) {
        setEnabled(ctx, false);
        ctx.stopService(new Intent(ctx, TripLogService.class));
    }
}
