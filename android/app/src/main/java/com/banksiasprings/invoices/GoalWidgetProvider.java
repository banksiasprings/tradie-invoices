package com.banksiasprings.invoices;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.os.Bundle;
import android.util.Log;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/**
 * v107.0 — the home-screen goal widget.
 *
 * This class does as little as possible: every callback here runs on the main
 * thread, so all it ever does is enqueue work. Reading the snapshot, drawing the
 * bar bitmap and building the RemoteViews all happen in
 * {@link WidgetRefreshWorker} on a background thread.
 *
 * The periodic refresh exists for one reason worth stating: the week rolls over
 * on Monday morning whether or not the app is opened, and a widget still showing
 * last week's hours on Tuesday is wrong in a way the user cannot see. It re-reads
 * the same snapshot and re-derives which bucket is "this week".
 */
public class GoalWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "GoalWidget";
    private static final String PERIODIC_WORK = "mcn_widget_periodic";
    static final long REFRESH_MINUTES = 30;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        requestRefresh(ctx);
    }

    /** Resize: re-render so the larger or smaller layout is picked up. */
    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle opts) {
        requestRefresh(ctx);
    }

    @Override
    public void onEnabled(Context ctx) {
        schedulePeriodic(ctx);
        requestRefresh(ctx);
    }

    /** Last widget removed — stop the periodic work rather than leave it burning. */
    @Override
    public void onDisabled(Context ctx) {
        try {
            WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC_WORK);
        } catch (Exception e) {
            Log.w(TAG, "cancel periodic failed: " + e.getMessage());
        }
    }

    /** Enqueue an immediate off-thread redraw. Safe to call from anywhere. */
    static void requestRefresh(Context ctx) {
        try {
            WorkManager.getInstance(ctx.getApplicationContext())
                    .enqueue(new OneTimeWorkRequest.Builder(WidgetRefreshWorker.class).build());
        } catch (Exception e) {
            Log.w(TAG, "enqueue refresh failed: " + e.getMessage());
        }
    }

    static void schedulePeriodic(Context ctx) {
        try {
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
                    WidgetRefreshWorker.class, REFRESH_MINUTES, TimeUnit.MINUTES).build();
            WorkManager.getInstance(ctx.getApplicationContext()).enqueueUniquePeriodicWork(
                    PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, req);
        } catch (Exception e) {
            Log.w(TAG, "schedule periodic failed: " + e.getMessage());
        }
    }

    static int[] installedIds(Context ctx) {
        try {
            return AppWidgetManager.getInstance(ctx)
                    .getAppWidgetIds(new ComponentName(ctx, GoalWidgetProvider.class));
        } catch (Exception e) {
            return new int[0];
        }
    }

    static int installedCount(Context ctx) {
        return installedIds(ctx).length;
    }
}
