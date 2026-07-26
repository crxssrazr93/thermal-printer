/* Offline shell for the installed app.
 *
 * Network first, cache second. Cache-first is the usual advice, but this
 * server runs on localhost where fetching costs nothing, and cache-first
 * means every edit to the CSS or JS stays invisible until the cache is
 * cleared by hand. Network-first keeps the app current and still opens when
 * the server is not running.
 *
 * API responses are never cached: printer state, presets and to-dos have to
 * be live.
 */
const CACHE = 'thermal-shell-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // keep the offline copy in step with whatever was just served
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || Response.error()))
  );
});
