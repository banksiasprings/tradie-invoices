package com.banksiasprings.invoices;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Re-registers all geofences after the device reboots OR the app is updated —
 * Android drops them in both cases. Declared in AndroidManifest.xml with
 * BOOT_COMPLETED + MY_PACKAGE_REPLACED intent filters.
 *
 * The pre-v81 version tried to launch MainActivity instead — Android 10+
 * blocks background activity starts, so it silently did nothing and geofences
 * stayed dead until the user next opened the app.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        // v101.6: this path used to be completely silent — if it never fired, or
        // fired and failed, there was no way to tell from the outside. The
        // emulator harness asserts on these lines.
        android.util.Log.i(TAG, "onReceive action=" + action);
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            GeoRegistrar.registerFromPrefs(context);
            // v101.6: trip logging must come back after a reboot too. Before
            // this, trip capture was a JS-started watcher — a reboot killed it
            // permanently until the user happened to open the app again.
            boolean want = TripLogService.isEnabled(context);
            android.util.Log.i(TAG, "trip logging enabled=" + want);
            if (want) {
                try {
                    TripLogService.start(context);
                    android.util.Log.i(TAG, "trip logging restarted");
                } catch (Exception e) {
                    // Android 12+ throws ForegroundServiceStartNotAllowedException
                    // for a background FGS start outside an allowed case.
                    // BOOT_COMPLETED is allowed; MY_PACKAGE_REPLACED is not.
                    TripLogService.recordError(context, "boot restart failed: " + e.getMessage());
                    android.util.Log.e(TAG, "trip logging restart FAILED", e);
                }
            }
        }
    }
}
