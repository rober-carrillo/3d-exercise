/**
 * Where position fixes come from.
 *
 * The recorder does not care — it takes `{lat, lon, ele, accuracy, t}` and has
 * no opinion about who produced it. That is deliberate: the browser's
 * geolocation only runs while the app is in front of you, and recording a real
 * outing needs a native background service. When that arrives, it arrives as
 * another function in this file, and nothing downstream changes.
 *
 *   browser  — navigator.geolocation. Foreground only: the fixes stop the
 *              moment the page is hidden or the screen sleeps.
 *   native   — an Android foreground service, which keeps reporting with the
 *              screen off and the phone in a pocket. This is the one that makes
 *              the app usable for an actual outing.
 *   replay   — plays a recorded track back through the same interface, so the
 *              record screen can be built and tested without going outside.
 *
 * `pickGeo` chooses, so callers do not have to care which they got.
 */

export const geoAvailable = () =>
  typeof navigator !== 'undefined' && !!navigator.geolocation;

/**
 * The device's own receiver.
 *
 * `enableHighAccuracy` is what asks for GPS rather than a guess from wifi and
 * cell towers; without it the fixes are tens to hundreds of metres out and the
 * recorder will reject nearly all of them.
 */
export function browserGeo({ onFix, onError, timeout = 20000 }) {
  let id = null;
  return {
    name: 'browser',
    start() {
      if (!geoAvailable()) { onError?.(new Error('This browser has no geolocation')); return; }
      id = navigator.geolocation.watchPosition(
        p => onFix({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          ele: p.coords.altitude ?? 0,
          accuracy: p.coords.accuracy ?? 999,
          speed: p.coords.speed ?? null,
          t: p.timestamp ?? Date.now(),
        }),
        err => onError?.(err),
        { enableHighAccuracy: true, maximumAge: 0, timeout },
      );
    },
    stop() { if (id !== null) { navigator.geolocation.clearWatch(id); id = null; } },
  };
}

/**
 * A recorded track, played back as if it were happening now.
 *
 * Indispensable for building this: a record button cannot be checked from a
 * desk otherwise, and "go for a run and see" is a slow way to find a bug in a
 * timer. `speed` multiplies real time, and `jitter` adds metres of scatter so
 * the filtering gets something to chew on.
 */
export function replayGeo({ points, onFix, onError, speed = 20, jitter = 0, accuracy = 6, onEnd }) {
  let i = 0, timer = null, t0 = null, wall0 = null;
  const noise = m => (Math.random() - 0.5) * 2 * m;
  return {
    name: 'replay',
    start() {
      if (!points?.length) { onError?.(new Error('nothing to replay')); return; }
      t0 = points[0][3] ?? Date.now();
      wall0 = Date.now();
      const tick = () => {
        const elapsed = (Date.now() - wall0) * speed;
        while (i < points.length && (points[i][3] - t0) <= elapsed) {
          const [lat, lon, ele] = points[i];
          onFix({
            lat: lat + noise(jitter) / 111320,
            lon: lon + noise(jitter) / 111320 / Math.cos(lat * Math.PI / 180),
            ele, accuracy, speed: null,
            // the track's own clock, not the wall clock: speeding up delivery
            // must not make the runner look like they are doing 900 km/h
            t: points[i][3],
          });
          i++;
        }
        if (i >= points.length) { clearInterval(timer); timer = null; onEnd?.(); }
      };
      timer = setInterval(tick, 100);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

/**
 * Hold the screen awake for the duration of a recording.
 *
 * Not a nicety. A browser stops delivering position fixes once the page is
 * hidden, and a phone in a pocket locks its screen within a minute, so without
 * this a recorded walk is a recorded first minute. The lock is also dropped
 * every time the page is hidden — answering a message is enough — so it has to
 * be taken again when the page comes back.
 *
 * Wake locks are refused in plenty of places (older WebViews, low battery,
 * browsers that never implemented it). That is survivable, and the caller is
 * told so it can say something honest on screen rather than pretend.
 *
 * Returns `{ release, held }`.
 */
export function keepAwake({ onChange } = {}) {
  let lock = null, live = true;
  const held = () => !!lock;

  const take = async () => {
    if (!live || lock || !navigator.wakeLock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; onChange?.(false); });
      onChange?.(true);
    } catch {
      lock = null;
      onChange?.(false);          // refused: the screen will sleep on its own
    }
  };
  const onVisible = () => { if (document.visibilityState === 'visible') take(); };

  document.addEventListener('visibilitychange', onVisible);
  take();

  return {
    held,
    release() {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
      try { lock?.release(); } catch {}
      lock = null;
    },
  };
}

/* ---------- native: keeps going with the screen off ---------- */

/**
 * Our own recording service, built into the app rather than installed from a
 * package, because the notification is the point: it has to show how far you
 * have gone and offer a way to pause without unlocking the phone, and a
 * notification can only be changed by whoever owns the service showing it.
 */
const recorderPlugin = () =>
  (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.())
    ? window.Capacitor.Plugins?.SalpiconRecorder ?? null
    : null;

export const nativeGeoAvailable = () => !!recorderPlugin();

/**
 * Recording that survives the screen going off.
 *
 * `onAction` is called when one of the notification's buttons is pressed, with
 * 'pause', 'resume' or 'finish'. Those buttons are best effort: some launchers
 * and locked-down OEM shells drop notification actions without reporting it,
 * and Android offers no way to ask whether they survived. So nothing depends
 * on them — they are a shortcut to controls that also exist on the screen.
 */
export function nativeGeo({ onFix, onError, onAction, title = 'Recording a route', text = 'Waiting for GPS…' }) {
  const plugin = recorderPlugin();
  let handles = [];
  return {
    name: 'native',
    async start() {
      if (!plugin) { onError?.(new Error('Background recording needs the Android app')); return; }
      try {
        handles.push(await plugin.addListener('fix', f => onFix({
          lat: f.lat, lon: f.lon, ele: f.ele ?? 0,
          accuracy: f.accuracy ?? 999, speed: f.speed ?? null, t: f.t ?? Date.now(),
        })));
        handles.push(await plugin.addListener('action', e => onAction?.(e.action)));
        handles.push(await plugin.addListener('recordingError', e =>
          onError?.(new Error(e.message || 'recording error'))));
        const res = await plugin.start({ title, text });
        return res;
      } catch (err) {
        onError?.(Object.assign(new Error(err.message || 'could not start recording'), {
          code: err.code, canOpenSettings: err.code === 'NOT_AUTHORIZED',
        }));
      }
    },
    /** New numbers for the notification. Cheap enough to call every second. */
    update(fields) { return plugin?.update(fields).catch(() => {}); },
    stop() {
      for (const h of handles) { try { h.remove(); } catch {} }
      handles = [];
      plugin?.stop().catch(() => {});
    },
    /** Android's own page for this app's notifications, for when they are off. */
    openSettings() { return plugin?.openNotificationSettings?.().catch(() => {}); },
  };
}

/**
 * What the shade will actually show.
 *
 * Three of the four failure modes can be detected and the fourth cannot, so
 * this reports what is knowable and the caller degrades on that:
 *
 *   'full'     notifications are permitted — post the rich one and hope the
 *              buttons survive, because nothing reports whether they did
 *   'blocked'  the permission was refused, or the channel was switched off:
 *              nothing will be shown however it is posted
 *   'unknown'  no way to ask, which is every browser
 *
 * Whether a shown notification kept its buttons is the unknowable one. Android
 * exposes no signal for it, so the app screen stays the control that works.
 */
export async function notificationState() {
  const plugin = recorderPlugin();
  if (!plugin?.notificationState) return 'unknown';
  try {
    const { state } = await plugin.notificationState();
    return state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The best source this device can offer. Native where there is one, otherwise
 * the browser, which works but only while you are looking at it.
 */
export function pickGeo(opts) {
  return nativeGeoAvailable() ? nativeGeo(opts) : browserGeo(opts);
}

/**
 * Get the receiver warm before anyone presses Record.
 *
 * A GPS that has been idle takes tens of seconds to go from a rough
 * cell-tower guess to a real fix, and the first stretch of a route is exactly
 * where that shows: a scatter of wild points before the track settles down.
 * Holding a watch open from the moment the app is opened means the receiver
 * already has satellites by the time anyone is ready to start.
 *
 * It asks for nothing. If the location permission has not been granted yet
 * this does nothing at all rather than throwing a prompt at someone who has
 * only just opened the app — they will be asked when they press Record, which
 * is the moment it makes sense to ask.
 */
export function warmUp({ onAccuracy, maxMs = 10 * 60 * 1000 } = {}) {
  let id = null, timer = null, best = Infinity;
  const stop = () => {
    if (id !== null) { try { navigator.geolocation.clearWatch(id); } catch {} id = null; }
    if (timer) { clearTimeout(timer); timer = null; }
  };

  (async () => {
    if (!geoAvailable()) return;
    try {
      // only if it is already ours; never prompt from here
      const st = await navigator.permissions?.query?.({ name: 'geolocation' });
      if (st && st.state !== 'granted') return;
    } catch { return; }           // no Permissions API: do not risk a prompt
    id = navigator.geolocation.watchPosition(
      p => {
        best = Math.min(best, p.coords.accuracy ?? Infinity);
        onAccuracy?.(p.coords.accuracy ?? null, best);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
    // a receiver left running all afternoon is a flat battery
    timer = setTimeout(stop, maxMs);
  })();

  return { stop, best: () => best };
}
