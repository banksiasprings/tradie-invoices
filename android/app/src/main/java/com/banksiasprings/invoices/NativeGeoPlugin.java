package com.banksiasprings.invoices;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

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

    @Override
    public void load() {
        geofencingClient = LocationServices.getGeofencingClient(getActivity());
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
     * Atomically read and clear pending events in one call.
     * Eliminates the read-clear race where the receiver can append between
     * JS's getPendingEvents() and clearPendingEvents() — which would otherwise
     * cause those new events to be silently lost on the next clear.
     */
    @PluginMethod
    public void drainPendingEvents(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, 0);
        String eventsJson;
        synchronized (NativeGeoPlugin.class) {
            eventsJson = prefs.getString(EVENTS_KEY, "[]");
            prefs.edit().putString(EVENTS_KEY, "[]").apply();
        }
        JSObject result = new JSObject();
        result.put("events", eventsJson);
        call.resolve(result);
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

    private PendingIntent getGeofencePendingIntent() {
        if (geofencePendingIntent != null) return geofencePendingIntent;
        Intent intent = new Intent(getContext(), GeofenceBroadcastReceiver.class);
        geofencePendingIntent = PendingIntent.getBroadcast(
                getContext(), 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        return geofencePendingIntent;
    }
}
