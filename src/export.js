/**
 * Getting a route out of the app as a file.
 *
 * Two different problems wearing the same word. In a browser, "download" is an
 * anchor with a blob behind it. In an Android WebView it is nothing at all:
 * Capacitor's WebView installs no DownloadListener, so `<a download>` is inert
 * and clicking it appears to work while producing no file. The app instead
 * writes to its own cache and opens the system share sheet, which is how a
 * phone expects to hand a file to something else anyway — mail it to yourself,
 * drop it in Drive, send it to a laptop.
 */

const native = () =>
  (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.())
    ? window.Capacitor.Plugins
    : null;

export const canShareFiles = () => {
  const p = native();
  return !!(p?.Filesystem && p?.Share);
};

/** A filename that will survive every filesystem it might land on. */
export const safeName = name =>
  (String(name || 'route').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'route') + '.gpx';

/**
 * Hand `text` to the user as `filename`.
 *
 * Returns how it went out — 'shared' or 'downloaded' — so the caller can say
 * something true, since the two produce very different experiences and only
 * one of them ends with a file in a Downloads folder.
 */
export async function saveGPX(filename, text) {
  const plugins = native();

  if (plugins?.Filesystem && plugins?.Share) {
    // Cache, not Documents: this is a copy on its way somewhere else, and the
    // OS is free to reclaim it once the share is done.
    const { uri } = await plugins.Filesystem.writeFile({
      path: filename,
      data: text,
      directory: 'CACHE',
      encoding: 'utf8',
    });
    await plugins.Share.share({
      title: filename,
      text: 'Route recorded with Relieve',
      url: uri,
      dialogTitle: 'Send this route',
    });
    return 'shared';
  }

  const url = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
