package com.banksiasprings.invoices;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Restarts the app's main activity after the device reboots.
 * This ensures background geolocation monitoring resumes automatically.
 * Declared in AndroidManifest.xml with BOOT_COMPLETED intent filter.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Intent launch = new Intent(context, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(launch);
        }
    }
}
