package com.banksiasprings.invoices;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.SizeF;
import android.widget.RemoteViews;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.HashMap;
import java.util.Map;

/**
 * v107.0 — every widget read and redraw happens here, on a WorkManager thread.
 *
 * The provider's callbacks all run on the main thread, so they only ever enqueue
 * this. Parsing JSON and rasterising the week bars are both cheap, but "cheap"
 * on the main thread is still the wrong place for file I/O.
 */
public class WidgetRefreshWorker extends Worker {

    private static final String TAG = "GoalWidget";

    // Breakpoints in dp. Android's cell arithmetic is 70n - 30, so 2x1 = 110x40,
    // 2x2 = 110x110, 4x2 = 250x110.
    private static final int MED_MIN_H = 100;
    private static final int LARGE_MIN_W = 220;

    public WidgetRefreshWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            int[] ids = GoalWidgetProvider.installedIds(ctx);
            if (ids.length == 0) return Result.success();

            WidgetStore.Snapshot snap = WidgetStore.load(ctx);
            long now = System.currentTimeMillis();

            for (int id : ids) {
                try {
                    mgr.updateAppWidget(id, viewsFor(ctx, mgr, id, snap, now));
                } catch (Exception e) {
                    Log.w(TAG, "render " + id + " failed: " + e.getMessage());
                }
            }
            return Result.success();
        } catch (Exception e) {
            Log.w(TAG, "refresh failed: " + e.getMessage());
            // A failed redraw leaves the last good render on screen, which is
            // strictly better than clearing it — retrying would only redraw the
            // same snapshot, so there is nothing to gain from Result.retry().
            return Result.success();
        }
    }

    /**
     * On API 31+ hand the launcher all three layouts and let it choose per size —
     * that also covers sizes we never enumerated, and updates instantly on resize
     * without waiting for an options callback. Below 31 there is no such API, so
     * pick from the reported min width/height.
     */
    private RemoteViews viewsFor(Context ctx, AppWidgetManager mgr, int id,
                                 WidgetStore.Snapshot s, long now) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Map<SizeF, RemoteViews> m = new HashMap<>();
            m.put(new SizeF(110f, 40f),  WidgetRenderer.build(ctx, s, WidgetRenderer.Size.SMALL, now));
            m.put(new SizeF(110f, 110f), WidgetRenderer.build(ctx, s, WidgetRenderer.Size.MEDIUM, now));
            m.put(new SizeF(250f, 110f), WidgetRenderer.build(ctx, s, WidgetRenderer.Size.LARGE, now));
            return new RemoteViews(m);
        }
        Bundle o = mgr.getAppWidgetOptions(id);
        int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 110);
        int h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 40);
        WidgetRenderer.Size size = (h >= MED_MIN_H && w >= LARGE_MIN_W) ? WidgetRenderer.Size.LARGE
                : (h >= MED_MIN_H) ? WidgetRenderer.Size.MEDIUM
                : WidgetRenderer.Size.SMALL;
        return WidgetRenderer.build(ctx, s, size, now);
    }
}
