package com.banksiasprings.invoices;

import android.Manifest;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.ContextCompat;
import androidx.localbroadcastmanager.content.LocalBroadcastManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
    name = "NativeGeo",
    permissions = {
        @Permission(
            strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION },
            alias = "location"
        ),
        @Permission(
            strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION },
            alias = "backgroundLocation"
        )
    }
)
public class NativeGeoPlugin extends Plugin {

    private static final String TAG = "NativeGeoPlugin";
    private static final String PREFS_NAME = "native_geo_prefs";
    private static final String EVENTS_KEY = "pending_events";
    private static final String SITES_KEY = "registered_sites";

    private GeofencingClient geofencingClient;
    private PendingIntent geofencePendingIntent;

    // Receiver for the LOCAL broadcast sent by GeofenceBroadcastReceiver after it
    // saves a fence transition to SharedPreferences. Forwards the event to JS in
    // real-time so the app can react while in foreground/background — otherwise
    // events sit unread in SharedPreferences until the next app cold open.
    private final BroadcastReceiver localGeoReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String eventJson = intent.getStringExtra("eventJson");
            if (eventJson == null) return;
            try {
                JSONObject ev = new JSONObject(eventJson);
                JSObject data = new JSObject();
                data.put("site", ev.optString("site"));
                data.put("type", ev.optString("type"));
                data.put("time", ev.optString("time"));
                data.put("date", ev.optString("date"));
                data.put("timestamp", ev.optLong("timestamp"));
                notifyListeners("geoEvent", data);
                Log.d(TAG, "Forwarded real-time geoEvent to JS: " + data.toString());
            } catch (Exception e) {
                Log.e(TAG, "Failed to forward geoEvent", e);
            }
        }
    };

    @Override
    public void load() {
        geofencingClient = LocationServices.getGeofencingClient(getActivity());
        // Subscribe to local broadcasts emitted by GeofenceBroadcastReceiver so we
        // can deliver events to JS as they happen (not just on next cold open).
        LocalBroadcastManager.getInstance(getContext()).registerReceiver(
                localGeoReceiver,
                new IntentFilter("com.banksiasprings.invoices.GEO_EVENT"));
    }

    @Override
    protected void handleOnDestroy() {
        try {
            LocalBroadcastManager.getInstance(getContext()).unregisterReceiver(localGeoReceiver);
        } catch (Exception e) {
            Log.w(TAG, "unregisterReceiver failed: " + e.getMessage());
        }
        super.handleOnDestroy();
    }

    /**
     * Request location permissions — must be called from JS before registerSites().
     * Android requires two steps: foreground first, then background separately.
     * Background location shows a system Settings page where user selects "Allow all the time".
     */
    @PluginMethod
    public void requestNativePermissions(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermissionCallback");
        } else if (getPermissionState("backgroundLocation") != PermissionState.GRANTED) {
            requestPermissionForAlias("backgroundLocation", call, "backgroundPermissionCallback");
        } else {
            // Already fully granted
            JSObject result = new JSObject();
            result.put("location", "granted");
            result.put("backgroundLocation", "granted");
            call.resolve(result);
        }
    }

    @PermissionCallback
    private void locationPermissionCallback(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            // Foreground granted — now request background (takes user to Settings)
            requestPermissionForAlias("backgroundLocation", call, "backgroundPermissionCallback");
        } else {
            call.reject("Location permission denied. Please allow location access to use geofencing.");
        }
    }

    @PermissionCallback
    private void backgroundPermissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("location", getPermissionState("location").toString().toLowerCase());
        result.put("backgroundLocation", getPermissionState("backgroundLocation").toString().toLowerCase());
        if (getPermissionState("backgroundLocation") == PermissionState.GRANTED) {
            call.resolve(result);
        } else {
            call.reject("Background location not granted. Open Settings → Invoice & PDF → Location and select 'Allow all the time'.");
        }
    }

    /**
     * Called from JS to register all job sites as native geofences.
     * Expects: { sites: [ { name, lat, lng, radius } ] }
     * Call requestNativePermissions() first.
     */
    @PluginMethod
    public void registerSites(PluginCall call) {
        JSArray sitesArr = call.getArray("sites");
        if (sitesArr == null) {
            call.reject("No sites provided");
            return;
        }

        // Check permissions are granted
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("Location permissions not granted — call requestNativePermissions() first");
            return;
        }

        try {
            List<Geofence> geofences = new ArrayList<>();
            JSONArray sitesJson = new JSONArray(sitesArr.toString());

            for (int i = 0; i < sitesJson.length(); i++) {
                JSONObject site = sitesJson.getJSONObject(i);
                String name = site.getString("name");
                double lat = site.getDouble("lat");
                double lng = site.getDouble("lng");
                float radius = (float) site.optDouble("radius", 150.0);

                geofences.add(new Geofence.Builder()
                        .setRequestId(name)
                        .setCircularRegion(lat, lng, radius)
                        .setTransitionTypes(
                                Geofence.GEOFENCE_TRANSITION_ENTER |
                                Geofence.GEOFENCE_TRANSITION_EXIT)
                        .setExpirationDuration(Geofence.NEVER_EXPIRE)
                        .setLoiteringDelay(30000) // 30s dwell before ENTER fires
                        .build());
            }

            if (geofences.isEmpty()) {
                call.resolve(new JSObject().put("registered", 0));
                return;
            }

            GeofencingRequest request = new GeofencingRequest.Builder()
                    .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
                    .addGeofences(geofences)
                    .build();

            geofencingClient.addGeofences(request, getGeofencePendingIntent())
                    .addOnSuccessListener(aVoid -> {
                        Log.d(TAG, "Registered " + geofences.size() + " geofences");
                        // Persist site list so we can re-register after reboot
                        getContext().getSharedPreferences(PREFS_NAME, 0)
                                .edit().putString(SITES_KEY, sitesArr.toString()).apply();
                        JSObject result = new JSObject();
                        result.put("registered", geofences.size());
                        call.resolve(result);
                    })
                    .addOnFailureListener(e -> {
                        Log.e(TAG, "Failed to add geofences", e);
                        call.reject("Geofencing registration failed: " + e.getMessage());
                    });

        } catch (Exception e) {
            Log.e(TAG, "registerSites error", e);
            call.reject("Error: " + e.getMessage());
        }
    }

    /**
     * Returns pending geo events that were collected while the app was dead.
     * JS should call this on app foreground/resume.
     */
    @PluginMethod
    public void getPendingEvents(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, 0);
        String eventsJson = prefs.getString(EVENTS_KEY, "[]");
        JSObject result = new JSObject();
        result.put("events", eventsJson);
        call.resolve(result);
    }

    /**
     * Clears the pending event queue after JS has processed them.
     */
    @PluginMethod
    public void clearPendingEvents(PluginCall call) {
        getContext().getSharedPreferences(PREFS_NAME, 0)
                .edit().putString(EVENTS_KEY, "[]").apply();
        call.resolve();
    }

    /**
     * Remove all registered geofences (used when sites list changes).
     */
    @PluginMethod
    public void removeAll(PluginCall call) {
        geofencingClient.removeGeofences(getGeofencePendingIntent())
                .addOnSuccessListener(v -> call.resolve())
                .addOnFailureListener(e -> call.reject("Remove failed: " + e.getMessage()));
    }

    /**
     * Open Android's "Ignore battery optimisation" prompt for this app.
     * Without this, aggressive battery management (e.g. Motorola "Restricted")
     * can defer or drop GeofencingClient transitions entirely — the very
     * background reliability we depend on. This plugin method opens the
     * system settings page that lets the user opt this app out of the
     * default optimisation policy.
     */
    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        try {
            Context ctx = getContext();
            String pkg = ctx.getPackageName();
            JSObject result = new JSObject();

            // On Android 6+ (M) check the current state so JS can know whether the
            // prompt is still needed. On older Android the optimisation framework
            // doesn't apply — return granted so the caller skips the prompt.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                boolean alreadyExempt = pm != null && pm.isIgnoringBatteryOptimizations(pkg);
                result.put("alreadyExempt", alreadyExempt);
                if (!alreadyExempt) {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + pkg));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(intent);
                    result.put("opened", true);
                } else {
                    result.put("opened", false);
                }
            } else {
                result.put("alreadyExempt", true);
                result.put("opened", false);
            }
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "requestBatteryOptimizationExemption error", e);
            call.reject("Could not open battery optimisation settings: " + e.getMessage());
        }
    }

    private PendingIntent getGeofencePendingIntent() {
        if (geofencePendingIntent != null) return geofencePendingIntent;
        Intent intent = new Intent(getContext(), GeofenceBroadcastReceiver.class);
        geofencePendingIntent = PendingIntent.getBroadcast(
                getContext(), 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        return geofencePendingIntent;
    }
}
