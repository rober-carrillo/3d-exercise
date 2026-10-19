package app.relieve;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * The service that keeps a recording alive once the screen goes off.
 *
 * Android hands location to a backgrounded app only while that app runs a
 * foreground service, and a foreground service must show a notification. The
 * community plugin this replaces built that notification once, from fixed
 * strings, with no actions — so it could never show how far you had gone or
 * offer a way to pause without unlocking the phone. Owning the service is the
 * only way to own the notification.
 *
 * Fixes and button presses go back to the web layer through the plugin, which
 * holds a static reference to itself; the service is started and stopped by
 * that same plugin, so the two live and die together.
 */
public class RecordingService extends Service implements LocationListener {
    public static final String ACTION_START  = "app.route3d.START";
    public static final String ACTION_UPDATE = "app.route3d.UPDATE";
    public static final String ACTION_PAUSE  = "app.route3d.PAUSE";
    public static final String ACTION_RESUME = "app.route3d.RESUME";
    public static final String ACTION_FINISH = "app.route3d.FINISH";

    // Version the channel id. A channel's importance belongs to the user the
    // moment it is created: later changes to it are ignored, for ever, on every
    // device that already has the old one. Correcting a channel therefore means
    // making a new one.
    private static final String CHANNEL = "route3d.recording.v2";
    private static final int NOTIFICATION_ID = 7301;

    private LocationManager locations;
    private boolean paused = false;
    private boolean foreground = false;
    private String line1 = "Recording";
    private String line2 = "Waiting for GPS…";

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            // DEFAULT rather than LOW, with the sound and vibration taken off
            // the channel instead. LOW marks a notification *silent*, and a
            // silent notification is hidden from the lock screen by default on
            // most devices — which is precisely where someone recording a walk
            // needs to see it. Muting the channel gets the quiet without the
            // demotion: no sound, no vibration, no heads-up banner, but a
            // notification the lock screen is willing to show.
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL, "Recording a route", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Shown while a route is being recorded");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(channel);
        }
        locations = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (action == null) action = ACTION_START;

        switch (action) {
            case ACTION_PAUSE:
                paused = true;
                RecordingPlugin.onAction("pause");
                break;
            case ACTION_RESUME:
                paused = false;
                RecordingPlugin.onAction("resume");
                break;
            case ACTION_FINISH:
                RecordingPlugin.onAction("finish");
                stopSelf();
                return START_NOT_STICKY;
            case ACTION_UPDATE:
                if (intent.hasExtra("line1")) line1 = intent.getStringExtra("line1");
                if (intent.hasExtra("line2")) line2 = intent.getStringExtra("line2");
                if (intent.hasExtra("paused")) paused = intent.getBooleanExtra("paused", false);
                break;
            default:
                if (intent != null && intent.hasExtra("line1")) line1 = intent.getStringExtra("line1");
                if (intent != null && intent.hasExtra("line2")) line2 = intent.getStringExtra("line2");
                break;
        }

        showNotification();
        startLocations();
        // START_STICKY so a service killed under memory pressure comes back;
        // the web layer reattaches and carries on from the fixes it already has.
        return START_STICKY;
    }

    private void startLocations() {
        if (locations == null) return;
        try {
            // GPS directly rather than the fused provider: no Play Services
            // dependency, and this app wants the satellite fix, not a guess
            // assembled from wifi. One second is what the filtering expects.
            locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this);
        } catch (SecurityException e) {
            RecordingPlugin.onError("Location permission was not granted");
        } catch (IllegalArgumentException e) {
            RecordingPlugin.onError("This device has no GPS provider");
        }
    }

    private void showNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_IMMUTABLE : 0;

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setContentTitle(line1)
                .setContentText(line2)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                // tints the icon and app name in the shade with the trail crimson
                .setColor(androidx.core.content.ContextCompat.getColor(this, R.color.route_crimson))
                .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | immutable))
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                // show the distance and the time on the lock screen itself,
                // rather than "Relieve: contents hidden"
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setShowWhen(false)
                // Android 12 and later hold a foreground service's notification
                // back for ten seconds unless told otherwise, which reads as
                // nothing having happened when you press Record
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                // the numbers are the point, so make sure a long distance or a
                // slow pace is not truncated on a narrow screen
                .setStyle(new NotificationCompat.BigTextStyle().bigText(line2));

        // Actions are best effort. Some launchers and locked-down OEM shells
        // drop them without telling anyone, which is why the web layer verifies
        // the notification arrived and falls back to plain text, and why the
        // app's own screen remains the control that always works.
        b.addAction(0, paused ? "Resume" : "Pause",
                servicePendingIntent(paused ? ACTION_RESUME : ACTION_PAUSE, 1, immutable));
        b.addAction(0, "Finish", servicePendingIntent(ACTION_FINISH, 2, immutable));

        Notification n = b.build();
        if (!foreground) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            foreground = true;
        } else {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, n);
        }
    }

    private PendingIntent servicePendingIntent(String action, int code, int immutable) {
        Intent i = new Intent(this, RecordingService.class).setAction(action);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | immutable);
    }

    @Override
    public void onLocationChanged(Location location) {
        if (paused) return;            // the service keeps running; the track does not grow
        RecordingPlugin.onFix(location);
    }

    // Required by LocationListener on older platforms; harmless on newer ones.
    @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
    @Override public void onProviderEnabled(String provider) {}
    @Override public void onProviderDisabled(String provider) {
        RecordingPlugin.onError("Location is switched off on this device");
    }

    @Override
    public void onDestroy() {
        if (locations != null) {
            try { locations.removeUpdates(this); } catch (SecurityException ignored) {}
        }
        foreground = false;
        super.onDestroy();
    }
}
