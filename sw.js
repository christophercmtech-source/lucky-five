const CACHE = "lucky-five-shell-v3";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/config.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Cache only the static app shell. Never cache API requests or private game results.
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && SHELL.includes(url.pathname)) {
      const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match("/index.html"))));
});
