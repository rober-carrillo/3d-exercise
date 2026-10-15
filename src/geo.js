/**
 * Where position fixes come from.
 *
 * The recorder does not care — it takes `{lat, lon, ele, accuracy, t}` and has
 * no opinion about who produced it. That is deliberate: the browser's
 * geolocation only runs while the app is in front of you, and recording a real
 * outing needs a native background service. When that arrives, it arrives as
 * another function in this file, and nothing downstream changes.
 *
 *   browser  — navigator.geolocation. Works today, foreground only.
 *   replay   — plays a recorded track back through the same interface, so the
 *              record screen can be built and tested without going outside.
 *   native   — Capacitor background geolocation. Not yet; see the plan.
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
