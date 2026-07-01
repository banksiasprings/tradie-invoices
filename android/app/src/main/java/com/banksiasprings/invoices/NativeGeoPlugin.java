package com.banksiasprings.invoices;

import android.Manifest;
import android.app.PendingIntent;
import android.app.usage.UsageStatsManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
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
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
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
                // v89: forward the v81 triggering-location telemetry too, so the
                // real-time JS path gets the SAME data the replayed/persisted path
                // does — and (critically) so a `rejected` garbage-accuracy event
                // delivered in real time is filtered by JS instead of acted on.
                if (ev.has("acc")) data.put("acc", ev.optInt("acc"));
                if (ev.has("distM")) data.put("distM", ev.optInt("distM"));
                if (ev.has("fixAgeMs")) data.put("fixAgeMs", ev.optLong("fixAgeMs"));
                if (ev.optBoolean("rejected")) {
                    data.put("rejected", true);
                    data.put("reason", ev.optString("reason"));
                }
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
            // Fence construction, transition types (DWELL|EXIT since v81), and
            // initial-trigger policy live in GeoRegistrar — shared with the
            // boot-time re-registration path so the two can never drift.
            List<Geofence> geofences = new ArrayList<>();
            JSONArray sitesJson = new JSONArray(sitesArr.toString());

            for (int i = 0; i < sitesJson.length(); i++) {
                JSONObject site = sitesJson.getJSONObject(i);
                if (!site.has("lat") || site.isNull("lat")) continue;
                geofences.add(GeoRegistrar.buildGeofence(site));
            }

            if (geofences.isEmpty()) {
                call.resolve(new JSObject().put("registered", 0));
                return;
            }

            GeofencingRequest request = GeoRegistrar.buildRequest(geofences);

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

    // ─── v92 SELF-DIAGNOSTIC HEALTH ──────────────────────────────────────────────
    // Reports every device setting that can silently kill background geofencing, so
    // JS can render a traffic-light Health tab and block "Start Shift" on a critical
    // fail. Read-only snapshot — no side effects. openHealthFix() fires the matching
    // system settings Intent for a given failing check.

    /**
     * Returns the current state of every reliability-critical device setting.
     * Everything JS needs to compute PASS/WARN/FAIL is here — JS does the mapping
     * so the thresholds/labels live in one place and can ship via OTA.
     */
    @PluginMethod
    public void getHealthStatus(PluginCall call) {
        Context ctx = getContext();
        String pkg = ctx.getPackageName();
        int sdk = Build.VERSION.SDK_INT;
        JSObject r = new JSObject();
        r.put("sdkInt", sdk);
        r.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        r.put("model", Build.MODEL == null ? "" : Build.MODEL);

        // 1. POST_NOTIFICATIONS — only a real permission on Android 13+ (API 33).
        //    Below that, notifications are granted by default.
        if (sdk >= 33) {
            boolean granted = ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
            r.put("postNotifications", granted ? "granted" : "denied");
        } else {
            r.put("postNotifications", "granted");
        }

        // 2. ACCESS_FINE_LOCATION — hard critical.
        boolean fine = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
        r.put("fineLocation", fine ? "granted" : "denied");

        // 3. ACCESS_BACKGROUND_LOCATION ("Allow all the time") — hard critical.
        //    Separate runtime permission only on Android 10+ (API 29); implicit before.
        if (sdk >= 29) {
            boolean bg = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
            r.put("backgroundLocation", bg ? "granted" : "denied");
        } else {
            r.put("backgroundLocation", fine ? "granted" : "denied");
        }

        // 4. Battery-optimisation whitelist — hard critical. Aggressive Doze/OEM
        //    battery management drops GeofencingClient transitions without this.
        if (sdk >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            r.put("batteryExempt", pm != null && pm.isIgnoringBatteryOptimizations(pkg));
        } else {
            r.put("batteryExempt", true);
        }

        // 5. App-Standby bucket — soft warning if RARE/RESTRICTED (API 28+).
        int bucket = -1;
        if (sdk >= 28) {
            try {
                UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
                if (usm != null) bucket = usm.getAppStandbyBucket();
            } catch (Exception e) { bucket = -1; }
        }
        r.put("standbyBucket", bucket);

        // 6. Manufacturer killer branch — JS renders the OEM-specific advisory;
        //    we can't programmatically read an OEM kill-list, so this is advisory.
        r.put("hasKnownKiller", isKnownKillerManufacturer());

        // 7. Google Play services — Geofencing API needs SUCCESS.
        int gms;
        try {
            gms = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(ctx);
        } catch (Throwable t) {
            gms = -1;
        }
        r.put("playServicesCode", gms);
        r.put("playServices", gms == ConnectionResult.SUCCESS ? "success" : "unavailable");

        // 8. RECEIVE_BOOT_COMPLETED — permission held AND BootReceiver enabled
        //    (self-audit that the build is wired correctly; re-registers fences post-reboot).
        boolean bootPerm = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECEIVE_BOOT_COMPLETED)
                == PackageManager.PERMISSION_GRANTED;
        boolean bootEnabled;
        try {
            int st = ctx.getPackageManager().getComponentEnabledSetting(new ComponentName(ctx, BootReceiver.class));
            bootEnabled = st != PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
        } catch (Exception e) {
            bootEnabled = false;
        }
        r.put("bootReceiver", bootPerm && bootEnabled);

        // 9. FOREGROUND_SERVICE_LOCATION declared — required on Android 14+ (API 34).
        boolean fgs;
        if (sdk >= 34) {
            fgs = false;
            try {
                PackageInfo pi = ctx.getPackageManager().getPackageInfo(pkg, PackageManager.GET_PERMISSIONS);
                if (pi.requestedPermissions != null) {
                    for (String p : pi.requestedPermissions) {
                        if ("android.permission.FOREGROUND_SERVICE_LOCATION".equals(p)) { fgs = true; break; }
                    }
                }
            } catch (Exception e) { fgs = false; }
        } else {
            fgs = true; // not required below API 34
        }
        r.put("fgsLocationDeclared", fgs);

        call.resolve(r);
    }

    /**
     * Fires the correct system-settings Intent for a failing check.
     * target ∈ { location, battery, doze, manufacturer, playservices, notifications }.
     * Every path falls back to the app-details page so a tap never dead-ends.
     */
    @PluginMethod
    public void openHealthFix(PluginCall call) {
        String target = call.getString("target", "");
        Context ctx = getContext();
        String pkg = ctx.getPackageName();
        JSObject res = new JSObject();
        res.put("target", target);
        try {
            boolean opened;
            switch (target) {
                case "battery":
                case "doze":
                    opened = openBatteryExemption(ctx, pkg);
                    break;
                case "manufacturer":
                    opened = openManufacturerBattery(ctx, pkg);
                    break;
                case "playservices":
                    opened = openPlayStore(ctx);
                    break;
                case "notifications":
                    opened = openNotificationSettings(ctx, pkg);
                    break;
                case "location":
                default:
                    opened = openAppDetails(ctx, pkg);
                    break;
            }
            res.put("opened", opened);
            call.resolve(res);
        } catch (Exception e) {
            Log.e(TAG, "openHealthFix error for target=" + target, e);
            try {
                openAppDetails(ctx, pkg);
                res.put("opened", true);
                call.resolve(res);
            } catch (Exception e2) {
                call.reject("Could not open settings: " + e.getMessage());
            }
        }
    }

    private boolean isKnownKillerManufacturer() {
        String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        return m.contains("motorola") || m.contains("samsung") || m.contains("xiaomi")
                || m.contains("redmi") || m.contains("poco") || m.contains("oppo")
                || m.contains("realme") || m.contains("huawei") || m.contains("honor")
                || m.contains("oneplus") || m.contains("vivo") || m.contains("iqoo")
                || m.contains("asus") || m.contains("lenovo") || m.contains("meizu");
    }

    private boolean openAppDetails(Context ctx, String pkg) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        i.setData(Uri.parse("package:" + pkg));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        return true;
    }

    private boolean openBatteryExemption(Context ctx, String pkg) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null && pm.isIgnoringBatteryOptimizations(pkg)) {
                // Already exempt — open the "All apps" list so the user can verify.
                if (tryStart(ctx, new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) return true;
                return openAppDetails(ctx, pkg);
            }
            Intent req = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            req.setData(Uri.parse("package:" + pkg));
            if (tryStart(ctx, req)) return true;
            if (tryStart(ctx, new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) return true;
        }
        return openAppDetails(ctx, pkg);
    }

    private boolean openNotificationSettings(Context ctx, String pkg) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
            if (tryStart(ctx, i)) return true;
        }
        return openAppDetails(ctx, pkg);
    }

    private boolean openPlayStore(Context ctx) {
        Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.gms"));
        if (tryStart(ctx, market)) return true;
        Intent web = new Intent(Intent.ACTION_VIEW,
                Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.gms"));
        return tryStart(ctx, web);
    }

    /**
     * OEM battery-killer deep-links. Motorola is Steven's device (Edge 50 Neo) — it
     * runs near-stock Android (MyUX), so the standard ignore-battery-optimizations
     * dialog for THIS app is the one-tap "Don't optimize" path; the battery-
     * optimization "All apps" list is the Adaptive-Battery secondary. Other OEMs try
     * their known Autostart/Protected-apps activities, then fall back to the generic
     * battery list, then app details. Each candidate is wrapped so an
     * ActivityNotFoundException just advances to the next.
     */
    private boolean openManufacturerBattery(Context ctx, String pkg) {
        String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        List<Intent> candidates = new ArrayList<>();
        if (m.contains("motorola")) {
            Intent req = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            req.setData(Uri.parse("package:" + pkg));
            candidates.add(req);
            candidates.add(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        } else if (m.contains("samsung")) {
            candidates.add(comp("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"));
            candidates.add(comp("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"));
            candidates.add(comp("com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity"));
        } else if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) {
            candidates.add(comp("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"));
            candidates.add(comp("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"));
        } else if (m.contains("oppo") || m.contains("realme")) {
            candidates.add(comp("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"));
            candidates.add(comp("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
            candidates.add(comp("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"));
        } else if (m.contains("huawei") || m.contains("honor")) {
            candidates.add(comp("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
            candidates.add(comp("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"));
            candidates.add(comp("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"));
        } else if (m.contains("oneplus")) {
            candidates.add(comp("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"));
        } else if (m.contains("vivo") || m.contains("iqoo")) {
            candidates.add(comp("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"));
            candidates.add(comp("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"));
        }
        // Generic fallbacks for every device.
        candidates.add(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        for (Intent i : candidates) {
            if (tryStart(ctx, i)) return true;
        }
        return openAppDetails(ctx, pkg);
    }

    private Intent comp(String pkg, String cls) {
        Intent i = new Intent();
        i.setComponent(new ComponentName(pkg, cls));
        return i;
    }

    private boolean tryStart(Context ctx, Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private PendingIntent getGeofencePendingIntent() {
        if (geofencePendingIntent != null) return geofencePendingIntent;
        geofencePendingIntent = GeoRegistrar.getPendingIntent(getContext());
        return geofencePendingIntent;
    }
}
