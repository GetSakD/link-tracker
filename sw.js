/* Link Tracker service worker: opens instantly, keeps the map tiles you've seen. Live train data always comes from the network. */
var VERSION = 'lt-v3.0.1';
var SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './apple-touch-icon.png', './icon-512.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'];
var TILE_CACHE = 'lt-tiles-1', TILE_MAX = 600;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== TILE_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
function trimTiles() {
  caches.open(TILE_CACHE).then(function (c) { c.keys().then(function (keys) { if (keys.length > TILE_MAX) for (var i = 0; i < keys.length - TILE_MAX; i++) c.delete(keys[i]); }); });
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.hostname === 'api.pugetsound.onebusaway.org') return;               // live data: always network
  if (url.hostname === 'tiles.openfreemap.org') {                              // map: cache first, refresh in background
    e.respondWith(caches.open(TILE_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) { if (res.ok) { c.put(req, res.clone()); trimTiles(); } return res; }).catch(function () { return hit; });
        return hit || net;
      });
    }));
    return;
  }
  if (url.origin === self.location.origin || url.hostname === 'unpkg.com') {   // app shell: instant, then update
    e.respondWith(caches.open(VERSION).then(function (c) {
      return c.match(req, { ignoreSearch: url.origin === self.location.origin }).then(function (hit) {
        var net = fetch(req).then(function (res) { if (res.ok) c.put(req, res.clone()); return res; }).catch(function () { return hit; });
        return hit || net;
      });
    }));
  }
});
