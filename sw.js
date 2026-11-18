/* Link Tracker service worker.
   The app itself (HTML/JS) always comes from the network first, so you never get stuck on an old version;
   the saved copy is only used when you're offline. Map tiles are cached for speed. Live data is never cached. */
var VERSION = 'lt-v3.4.0';
var TILE_CACHE = 'lt-tiles-1', TILE_MAX = 600;
var LIB = ['https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return Promise.all(LIB.map(function (u) { return c.add(u).catch(function () {}); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== TILE_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
function netFirst(req) {
  return caches.open(VERSION).then(function (c) {
    var timeout = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('slow')); }, 4000); });
    return Promise.race([fetch(req, { cache: 'no-store' }), timeout]).then(function (res) {
      if (res && res.ok) c.put(req, res.clone());
      return res;
    }).catch(function () { return c.match(req, { ignoreSearch: true }).then(function (hit) { return hit || fetch(req); }); });
  });
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.hostname === 'api.pugetsound.onebusaway.org') return;                 // live data: always network
  if (url.origin === self.location.origin) { e.respondWith(netFirst(req)); return; }   // the app: newest first
  if (url.hostname === 'unpkg.com') {                                             // pinned library version: cache first
    e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req).then(function (res) { if (res.ok) caches.open(VERSION).then(function (c) { c.put(req, res.clone()); }); return res; }); }));
    return;
  }
  if (url.hostname === 'tiles.openfreemap.org') {                                // map: cache first, refresh in background
    e.respondWith(caches.open(TILE_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) { if (res.ok) { c.put(req, res.clone()); c.keys().then(function (k) { for (var i = 0; i < k.length - TILE_MAX; i++) c.delete(k[i]); }); } return res; }).catch(function () { return hit; });
        return hit || net;
      });
    }));
  }
});
