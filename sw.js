/* Link Tracker service worker.
   The app opens instantly from the copy saved on the phone (no waiting on a weak signal in a station).
   Every deploy changes VERSION, so the browser installs the new copy in the background and the app
   offers "New version ready". Map tiles are cached for speed. Live data is never cached. */
var VERSION = 'lt-v4.3.0';
var TILE_CACHE = 'lt-tiles-1', TILE_MAX = 600;
var LIB = ['https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'];
// the app shell, so it opens offline (underground, no signal)
var SHELL = ['./', 'css/app.css', 'js/main.js', 'js/config.js', 'js/util.js', 'js/state.js', 'js/loop.js', 'js/api.js', 'js/motion.js', 'js/line.js', 'js/trains.js',
  'js/fleet.js', 'js/buses.js', 'js/plan.js', 'js/realtime.js', 'js/map/map.js', 'js/map/icons.js', 'js/ui/dom.js', 'js/ui/parts.js', 'js/ui/views.js', 'js/ui/sheet.js',
  'js/ui/panels.js', 'js/ui/directions.js', 'js/ui/lineview.js', 'js/ui/theme.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return Promise.all(LIB.concat(SHELL).map(function (u) { return c.add(new Request(u, { cache: 'reload' })).catch(function () {}); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== TILE_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// the app: saved copy first; if a file isn't saved yet, fetch it (with a time limit) and save it
function shellFirst(req) {
  return caches.open(VERSION).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      var timeout = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('slow')); }, 8000); });
      return Promise.race([fetch(req, { cache: 'no-store' }), timeout]).then(function (res) {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      });
    });
  });
}
// trimming the tile cache lists every saved tile, so do it at most every 30 s, not on every tile
var lastTrim = 0;
function trimTiles(c) {
  if (Date.now() - lastTrim < 30000) return;
  lastTrim = Date.now();
  c.keys().then(function (k) { for (var i = 0; i < k.length - TILE_MAX; i++) c.delete(k[i]); });
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.hostname === 'api.pugetsound.onebusaway.org') return;                 // live data: always network
  if (url.origin === self.location.origin) { e.respondWith(shellFirst(req)); return; }   // the app: instant from the saved copy
  if (url.hostname === 'unpkg.com') {                                             // pinned library version: cache first
    e.respondWith(caches.match(req).then(function (hit) { return hit || fetch(req).then(function (res) { if (res.ok) caches.open(VERSION).then(function (c) { c.put(req, res.clone()); }); return res; }); }));
    return;
  }
  if (url.hostname === 'tiles.openfreemap.org') {                                // map: cache first, refresh in background
    e.respondWith(caches.open(TILE_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) { if (res.ok) { c.put(req, res.clone()); trimTiles(c); } return res; }).catch(function () { return hit; });
        return hit || net;
      });
    }));
  }
});
