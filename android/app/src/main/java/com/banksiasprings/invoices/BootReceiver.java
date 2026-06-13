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
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            GeoRegistrar.registerFromPrefs(context);
        }
    }
}
