package app.salpicon;

import android.content.Intent;
import android.location.Location;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import android.Manifest;

/**
 * The bridge between the recording service and the web layer.
 *
 * Deliberately thin: it starts and stops the service, passes new notification
 * text down, and passes fixes and button presses up. Everything that decides
 * what a fix means — whether it counts as movement, how far it carries you,
 * what the notification should say — stays in JavaScript, where it is already
 * written and tested against a decade of recorded tracks. Putting any of that
 * here would mean a second implementation of the subtlest code in the project.
 */
@CapacitorPlugin(
        name = "SalpiconRecorder",
        permissions = {
                @Permission(
                        alias = "location",
                        strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }
                ),
                @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
        }
)
public class RecordingPlugin extends Plugin {
    private static RecordingPlugin instance;

    @Override
    public void load() { instance = this; }

    /**
     * Has this app been given *precise* location, as opposed to approximate?
     *
     * Android 12 split the prompt in two, and the alias above lists both fine
     * and coarse, so Capacitor reports the permission GRANTED when somebody
     * taps "Approximate". Everything then looks fine and nothing works: the
     * fused provider answers from wifi and cell towers, which is accurate to
     * a few hundred metres and never improves, so every fix is thrown out by
     * the accuracy filter and the recording never starts. The raw GPS provider
     * used to throw a SecurityException in the same situation, which at least
     * said something. This is how we say something now.
     */
    private boolean hasPrecise() {
        return androidx.core.content.ContextCompat.checkSelfPermission(
                getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /* ---------- called from the service ---------- */

    static void onFix(Location l) {
        if (instance == null) return;
        JSObject o = new JSObject();
        o.put("lat", l.getLatitude());
        o.put("lon", l.getLongitude());
        // Height above sea level where the platform can give it, and height
        // above the WGS84 ellipsoid where it cannot — which are not the same
        // number and differ by the geoid separation, about −32 m in San
        // Francisco and +50 m over Colombia. A recorded walk on flat ground at
        // 15 m came back as −14 m for exactly this reason. Android 14 is the
        // first version that will do the conversion; older ones hand over the
        // ellipsoidal figure and the app corrects it against the terrain model
        // instead (see src/elevation.js), which is better anyway.
        if (Build.VERSION.SDK_INT >= 34 && l.hasMslAltitude()) {
            o.put("ele", l.getMslAltitudeMeters());
            o.put("eleRef", "msl");
        } else {
            o.put("ele", l.hasAltitude() ? l.getAltitude() : 0);
            o.put("eleRef", l.hasAltitude() ? "ellipsoid" : "none");
        }
        o.put("accuracy", l.hasAccuracy() ? l.getAccuracy() : 999);
        o.put("speed", l.hasSpeed() ? l.getSpeed() : null);
        o.put("t", l.getTime());
        instance.notifyListeners("fix", o);
    }

    static void onAction(String which) {
        if (instance == null) return;
        JSObject o = new JSObject();
        o.put("action", which);
        instance.notifyListeners("action", o);
    }

    static void onError(String message) {
        if (instance == null) return;
        JSObject o = new JSObject();
        o.put("message", message);
        instance.notifyListeners("recordingError", o);
    }

    /* ---------- called from JavaScript ---------- */

    @PluginMethod
    public void start(final PluginCall call) {
        // Location first: without it the service starts and reports nothing,
        // which looks exactly like the feature being broken.
        if (getPermissionState("location") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "afterLocation");
            return;
        }
        afterPermissions(call);
    }

    @PermissionCallback
    private void afterLocation(PluginCall call) {
        if (getPermissionState("location") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Location permission is needed to record a route", "NOT_AUTHORIZED");
            return;
        }
        // Android 13 hides every notification from an app without this, the
        // foreground service's included — so the recording would run unseen.
        if (Build.VERSION.SDK_INT >= 33
                && getPermissionState("notifications") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotifications");
            return;
        }
        afterPermissions(call);
    }

    @PermissionCallback
    private void afterNotifications(PluginCall call) {
        // A refusal here is survivable: recording still works, it is simply
        // invisible until the app is reopened. Carry on rather than refuse.
        afterPermissions(call);
    }

    private void afterPermissions(PluginCall call) {
        Intent i = new Intent(getContext(), RecordingService.class)
                .setAction(RecordingService.ACTION_START)
                .putExtra("line1", call.getString("title", "Recording a route"))
                .putExtra("line2", call.getString("text", "Waiting for GPS…"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(i);
        else getContext().startService(i);

        JSObject res = new JSObject();
        res.put("started", true);
        res.put("notifications", getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED);
        // The caller needs this to explain why a recording is going nowhere.
        res.put("precise", hasPrecise());
        call.resolve(res);
    }

    /**
     * Start the receiver early, for a little while, without recording anything.
     *
     * A cold GNSS fix takes the better part of a minute, and most people open
     * this app in order to press Record within seconds of opening it. Asking
     * for position the moment the app is in front of somebody means the
     * satellites are found while they are still putting their headphones in,
     * rather than over the first block of the run.
     *
     * No foreground service and no notification: this stops on its own, and it
     * is not a recording. If permission has not been granted yet it does
     * nothing at all rather than prompting — being asked for location by an
     * app you have only just opened, for no stated reason, is how people
     * refuse.
     */
    @PluginMethod
    public void warm(PluginCall call) {
        JSObject res = new JSObject();
        if (getPermissionState("location") != com.getcapacitor.PermissionState.GRANTED) {
            res.put("warming", false);
            res.put("reason", "no permission yet");
            call.resolve(res);
            return;
        }
        int seconds = call.getInt("seconds", 20);
        Intent i = new Intent(getContext(), RecordingService.class)
                .setAction(RecordingService.ACTION_WARM)
                .putExtra("seconds", seconds);
        getContext().startService(i);
        res.put("warming", true);
        res.put("precise", hasPrecise());
        call.resolve(res);
    }

    /**
     * Ask for location, on purpose, at a moment the app has explained itself.
     *
     * Separate from start() because the two are different conversations. By
     * the time somebody presses Record they have already decided to record;
     * a permission sheet then is an obstacle, and if they tap the wrong half
     * of it the feature is broken with no obvious way back. Android also
     * stops asking after a couple of refusals, so the one chance to ask is
     * worth spending where the reason can be given first.
     */
    @PluginMethod
    public void requestLocation(final PluginCall call) {
        if (getPermissionState("location") == com.getcapacitor.PermissionState.GRANTED) {
            resolvePrecision(call);
            return;
        }
        requestPermissionForAlias("location", call, "afterAsked");
    }

    @PermissionCallback
    private void afterAsked(PluginCall call) { resolvePrecision(call); }

    private void resolvePrecision(PluginCall call) {
        JSObject res = new JSObject();
        res.put("granted", getPermissionState("location") == com.getcapacitor.PermissionState.GRANTED);
        res.put("precise", hasPrecise());
        call.resolve(res);
    }

    /**
     * The app's own settings page, which is where location precision lives.
     *
     * Android will not show the location prompt again once it has been
     * refused, and it has no prompt at all for upgrading approximate to
     * precise. Settings is the only route, so the app has to be able to point
     * at it rather than describing where to go.
     */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.fromParts("package", getContext().getPackageName(), null));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Throwable t) {
            call.reject("Could not open settings");
        }
    }

    /** Whether precise location is available, without starting anything. */
    @PluginMethod
    public void precision(PluginCall call) {
        JSObject res = new JSObject();
        res.put("granted", getPermissionState("location") == com.getcapacitor.PermissionState.GRANTED);
        res.put("precise", hasPrecise());
        call.resolve(res);
    }

    /** New text for the notification: the elapsed time and distance so far. */
    @PluginMethod
    public void update(PluginCall call) {
        Intent i = new Intent(getContext(), RecordingService.class)
                .setAction(RecordingService.ACTION_UPDATE)
                .putExtra("line1", call.getString("title", "Recording a route"))
                .putExtra("line2", call.getString("text", ""))
                .putExtra("paused", Boolean.TRUE.equals(call.getBoolean("paused", false)));
        getContext().startService(i);
        call.resolve();
    }

    /**
     * What the notification shade will actually do with what we post.
     *
     * Three states are knowable. A fourth is not: whether a shown notification
     * kept its action buttons, which some launchers and OEM shells drop
     * silently. Android exposes no signal for that, so the caller treats the
     * buttons as a shortcut and never as the only way to control a recording.
     */
    @PluginMethod
    public void notificationState(PluginCall call) {
        JSObject res = new JSObject();
        androidx.core.app.NotificationManagerCompat nm =
                androidx.core.app.NotificationManagerCompat.from(getContext());
        if (!nm.areNotificationsEnabled()) {
            res.put("state", "blocked");
            res.put("reason", "notifications are switched off for this app");
            call.resolve(res);
            return;
        }
        // A granted permission is not the end of it: a channel the user turned
        // off swallows everything posted to it without complaint.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.NotificationChannel ch = nm.getNotificationChannel("salpicon.recording.v1");
            if (ch != null && ch.getImportance() == android.app.NotificationManager.IMPORTANCE_NONE) {
                res.put("state", "blocked");
                res.put("reason", "the recording notification channel is switched off");
                call.resolve(res);
                return;
            }
        }
        res.put("state", "full");
        call.resolve(res);
    }

    /**
     * Open the page where this can be fixed.
     *
     * Android stops asking once a permission prompt has been refused, so a
     * refusal is permanent as far as the app is concerned: there is no second
     * chance to ask, only Settings. Dropping someone into the right screen is
     * the difference between a fixable problem and a feature that is simply
     * broken for them.
     */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent i;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(android.net.Uri.fromParts("package", getContext().getPackageName(), null));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open the notification settings");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), RecordingService.class));
        call.resolve();
    }
}
