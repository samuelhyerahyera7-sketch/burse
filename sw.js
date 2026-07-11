// Minimal service worker — its only job is to satisfy the browser's PWA
// installability requirement (a fetch handler must exist). Deliberately
// does NOT cache API calls or app HTML: this is a live payroll/HR app,
// and stale cached data (an old leave balance, an old payslip) would be
// actively harmful. Static assets (icons) get a light cache-first pass.
const CACHE = 'burse-static-v1';
const PRECACHE = ['/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !PRECACHE.includes(url.pathname)) {
    return; // let everything else (HTML pages, Supabase API calls) go straight to the network
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
