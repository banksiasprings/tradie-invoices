package com.banksiasprings.invoices;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Shared geofence construction + registration logic.
 * Used by NativeGeoPlugin (registration from JS) and BootReceiver
 * (re-registration after reboot, when no activity/WebView exists).
 * Keeping fence + PendingIntent construction in one place guarantees the
 * boot path and the plugin path can never drift apart.
 */
public final class GeoRegistrar {

    private static final String TAG = "GeoRegistrar";
    static final String PREFS_NAME = "native_geo_prefs";
    static final String SITES_KEY = "registered_sites";

    /**
     * 30s dwell before an entry fires — kills boundary flutter at the source.
     * loiteringDelay only applies to DWELL transitions; the pre-v81 code
     * registered ENTER|EXIT, which silently ignored the delay entirely.
     */
    static final int LOITER_MS = 30000;

    private GeoRegistrar() {}

    static Geofence buildGeofence(JSONObject site) throws org.json.JSONException {
        String name = site.getString("name");
        double lat = site.getDouble("lat");
        double lng = site.getDouble("lng");
        float radius = (float) site.optDouble("radius", 150.0);
        return new Geofence.Builder()
                .setRequestId(name)
                .setCircularRegion(lat, lng, radius)
                .setTransitionTypes(
                        Geofence.GEOFENCE_TRANSITION_DWELL |
                        Geofence.GEOFENCE_TRANSITION_EXIT)
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setLoiteringDelay(LOITER_MS)
                .build();
    }

    static PendingIntent getPendingIntent(Context ctx) {
        Intent intent = new Intent(ctx, GeofenceBroadcastReceiver.class);
        return PendingIntent.getBroadcast(ctx, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    static GeofencingRequest buildRequest(List<Geofence> geofences) {
        return new GeofencingRequest.Builder()
                // No initial trigger: registering while already inside a fence must
                // NOT fire a synthetic event. Pre-v81 this was INITIAL_TRIGGER_ENTER
                // and the app re-registers on every open — so every app open at a
                // site fired a fresh ENTER (duplicate timer starts + notifications).
                .setInitialTrigger(0)
                .addGeofences(geofences)
                .build();
    }

    static boolean hasLocationPermissions(Context ctx) {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
    }

    /** Metres between two coordinates (WGS84, via Location.distanceBetween). */
    static double distMeters(double la1, double lo1, double la2, double lo2) {
        float[] res = new float[1];
        android.location.Location.distanceBetween(la1, lo1, la2, lo2, res);
        return res[0];
    }

    /** Look up a registered site's JSON by fence requestId (= site name). */
    static JSONObject findSite(Context ctx, String name) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray sites = new JSONArray(prefs.getString(SITES_KEY, "[]"));
            for (int i = 0; i < sites.length(); i++) {
                JSONObject s = sites.getJSONObject(i);
                if (name.equals(s.optString("name"))) return s;
            }
        } catch (Exception e) {
            Log.w(TAG, "findSite failed: " + e.getMessage());
        }
        return null;
    }

    /**
     * Re-register all fences from the persisted site list. Android drops all
     * geofences on reboot — BootReceiver calls this so they come back without
     * the user having to open the app. Best-effort: logs outcome, never throws.
     */
    static void registerFromPrefs(Context ctx) {
        try {
            if (!hasLocationPermissions(ctx)) {
                Log.w(TAG, "registerFromPrefs: location permissions missing — skipping");
                return;
            }
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray sites = new JSONArray(prefs.getString(SITES_KEY, "[]"));
            final List<Geofence> fences = new ArrayList<>();
            for (int i = 0; i < sites.length(); i++) {
                try {
                    JSONObject s = sites.getJSONObject(i);
                    if (!s.has("lat") || s.isNull("lat")) continue;
                    fences.add(buildGeofence(s));
                } catch (Exception perSite) {
                    Log.w(TAG, "registerFromPrefs: skipping malformed site: " + perSite.getMessage());
                }
            }
            if (fences.isEmpty()) {
                Log.d(TAG, "registerFromPrefs: no persisted sites with coordinates");
                return;
            }
            GeofencingClient client = LocationServices.getGeofencingClient(ctx);
            client.addGeofences(buildRequest(fences), getPendingIntent(ctx))
                    .addOnSuccessListener(v -> Log.d(TAG, "Re-registered " + fences.size() + " geofences"))
                    .addOnFailureListener(e -> Log.e(TAG, "Re-register failed", e));
        } catch (Exception e) {
            Log.e(TAG, "registerFromPrefs error", e);
        }
    }
}
