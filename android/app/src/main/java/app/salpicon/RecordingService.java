package app.salpicon;

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
    public static final String ACTION_START  = "app.salpicon.START";
    public static final String ACTION_UPDATE = "app.salpicon.UPDATE";
    public static final String ACTION_PAUSE  = "app.salpicon.PAUSE";
    public static final String ACTION_RESUME = "app.salpicon.RESUME";
    public static final String ACTION_FINISH = "app.salpicon.FINISH";
    /** Find the satellites now, record nothing, and stop on your own. */
    public static final String ACTION_WARM   = "app.salpicon.WARM";

    // Version the channel id. A channel's importance belongs to the user the
    // moment it is created: later changes to it are ignored, for ever, on every
    // device that already has the old one. Correcting a channel therefore means
    // making a new one.
    private static final String CHANNEL = "salpicon.recording.v1";
    private static final int NOTIFICATION_ID = 7301;

    private LocationManager locations;
    private com.google.android.gms.location.FusedLocationProviderClient fused;
    private boolean usingFused = false;

    /** Fixes from the fused provider arrive here instead of onLocationChanged. */
    private final com.google.android.gms.location.LocationCallback fusedCallback =
        new com.google.android.gms.location.LocationCallback() {
            @Override
            public void onLocationResult(com.google.android.gms.location.LocationResult result) {
                if (paused) return;
                Location l = result.getLastLocation();
                if (l != null) RecordingPlugin.onFix(l);
            }

            @Override
            public void onLocationAvailability(com.google.android.gms.location.LocationAvailability a) {
                if (!a.isLocationAvailable() && !warming) {
                    RecordingPlugin.onError("No position available — check that location is switched on");
                }
            }
        };
    private boolean paused = false;
    private boolean foreground = false;
    private boolean warming = false;          // a warm-up, not a recording
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
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
        try {
            fused = com.google.android.gms.location.LocationServices.getFusedLocationProviderClient(this);
        } catch (Throwable t) {
            fused = null;                     // no Play Services; the raw provider is the plan
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (action == null) action = ACTION_START;

        // A warm-up asks for position and nothing else: no notification, no
        // foreground promotion, no track. It stops itself, and a real Record
        // arriving in the meantime simply takes over the same provider.
        if (ACTION_WARM.equals(action)) {
            if (foreground) return START_STICKY;        // already recording; nothing to warm
            if (!warming) {
                warming = true;
                startLocations();
                int seconds = intent != null ? intent.getIntExtra("seconds", 20) : 20;
                handler.postDelayed(() -> {
                    if (warming && !foreground) { stopLocations(); warming = false; stopSelf(); }
                }, Math.max(5, Math.min(60, seconds)) * 1000L);
            }
            return START_NOT_STICKY;
        }
        warming = false;

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

    /**
     * Start asking for positions, by the best route this device offers.
     *
     * The fused provider first. It was avoided originally to keep Play
     * Services out of the build, on the reasoning that this app wants the
     * satellite fix rather than a guess assembled from wifi — which turned out
     * to be the wrong way round. Fused does not replace GNSS, it runs a motion
     * model over it using the accelerometer and gyroscope, and that model is
     * what tells a fix twenty metres to the left of a runner that it is wrong.
     * Measured against Strava over the same 494 m, the raw provider wandered
     * sideways about twice as far.
     *
     * Raw GPS stays as the fallback, and it is not a token one: a phone with
     * no Play Services — a de-Googled ROM, some Huawei models — records
     * exactly as it did before, through the same listener.
     */
    private void stopLocations() {
        if (usingFused && fused != null) {
            try { fused.removeLocationUpdates(fusedCallback); } catch (Throwable ignored) {}
            usingFused = false;
        }
        if (locations != null) {
            try { locations.removeUpdates(this); } catch (SecurityException ignored) {}
        }
    }

    private void startLocations() {
        stopLocations();                      // never stack two subscriptions
        if (fused != null && startFused()) return;
        if (locations == null) {
            RecordingPlugin.onError("This device has no location provider");
            return;
        }
        try {
            locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this);
        } catch (SecurityException e) {
            RecordingPlugin.onError("Location permission was not granted");
        } catch (IllegalArgumentException e) {
            RecordingPlugin.onError("This device has no GPS provider");
        }
    }

    private boolean startFused() {
        try {
            // waitForAccurateLocation true: the first thing fused can offer is
            // a wifi-and-cell estimate good to a few hundred metres, and with
            // it set false that estimate arrives immediately and the recording
            // screen sits on "±250 m" looking broken while the satellites are
            // still being found. Waiting costs a few seconds once, which the
            // warm-up has usually already spent.
            com.google.android.gms.location.LocationRequest req =
                new com.google.android.gms.location.LocationRequest.Builder(
                        com.google.android.gms.location.Priority.PRIORITY_HIGH_ACCURACY, 1000L)
                    .setMinUpdateIntervalMillis(1000L)
                    .setMinUpdateDistanceMeters(0f)
                    .setWaitForAccurateLocation(true)
                    .build();
            fused.requestLocationUpdates(req, fusedCallback, getMainLooper());
            usingFused = true;
            return true;
        } catch (SecurityException e) {
            RecordingPlugin.onError("Location permission was not granted");
            return true;                      // permission, not availability: do not fall back
        } catch (Throwable t) {
            // No Play Services on this device, or a version that does not know
            // this API. Nothing is wrong; the raw provider handles it.
            usingFused = false;
            return false;
        }
    }

    private void showNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_IMMUTABLE : 0;

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setContentTitle(line1)
                .setContentText(line2)
                .setSmallIcon(R.drawable.ic_stat_glass)
                // tints the icon and app name in the shade with the walk-light green
                .setColor(androidx.core.content.ContextCompat.getColor(this, R.color.brand_green))
                .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | immutable))
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                // show the distance and the time on the lock screen itself,
                // rather than "Salpicón!: contents hidden"
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
        handler.removeCallbacksAndMessages(null);
        stopLocations();
        warming = false;
        foreground = false;
        super.onDestroy();
    }
}
