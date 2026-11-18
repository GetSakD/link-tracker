'use strict';
/* Link Tracker — live 2 Line trains. Data: Sound Transit via OneBusAway Puget Sound. */

/* ================= config + helpers ================= */
var CFG = {
  base: window.OBA_BASE || 'https://api.pugetsound.onebusaway.org/api/where/',
  tz: 'America/Los_Angeles',
  route: '40_2LINE',
  north: { lat: 47.8155, lon: -122.2950 },          // Lynnwood City Center, the 2 Line's north end
  styleLight: window.MAP_STYLE_LIGHT || 'https://tiles.openfreemap.org/styles/positron',
  styleDark: window.MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark'
};
var store = {
  get: function (k, d) { try { var v = localStorage.getItem('lt3_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem('lt3_' + k, JSON.stringify(v)); } catch (e) {} },
  del: function (k) { try { localStorage.removeItem('lt3_' + k); } catch (e) {} }
};
function $(s, r) { return (r || document).querySelector(s); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
var fmtClock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CFG.tz });
function clock(ms) { return fmtClock.format(new Date(ms)); }
function dist(a, b) {
  var R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}
function miles(m) { var mi = m / 1609.34; return mi < 0.1 ? Math.round(m * 3.281 / 50) * 50 + ' ft' : (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi'; }
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function isDark() { return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches; }

/* ================= state ================= */
var S = {
  key: store.get('key', 'TEST'),
  refreshSec: store.get('refreshSec', 15),
  from: store.get('from', null), to: store.get('to', null),
  line: null,            // stations, platforms, shapes
  trips: {},             // tripId -> timetable
  stopInfo: {},          // stopId -> {name, lat, lon}
  veh: {},               // tripId -> live train
  arr: null,             // departures at your station
  alerts: [],
  offset: 0, lastOk: 0, err: null, busy: false,
  view: 'map', selected: null, follow: false,
  me: null, meWatch: null, detent: 'mid'
};
function now() { return Date.now() + S.offset; }

/* ================= OneBusAway API ================= */
var transport = null, lastCall = 0, cbN = 0;
function jsonp(url, ms) {
  return new Promise(function (resolve, reject) {
    var name = '__oba' + (++cbN), u = new URL(url.toString()), s = document.createElement('script');
    u.searchParams.set('callback', name);
    var timer = setTimeout(function () { done(); reject(new Error('Request timed out')); }, ms);
    function done() { clearTimeout(timer); try { delete window[name]; } catch (e) { window[name] = undefined; } if (s.parentNode) s.parentNode.removeChild(s); }
    window[name] = function (d) { done(); resolve(d); };
    s.onerror = function () { done(); reject(new Error('Network error')); };
    s.src = u.toString(); document.head.appendChild(s);
  });
}
function rawGet(u) {
  if (transport === 'jsonp') return jsonp(u, 15000);
  var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var t = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
  return fetch(u.toString(), ctl ? { signal: ctl.signal } : {}).then(function (r) {
    clearTimeout(t);
    return r.text().then(function (txt) {
      try { var j = JSON.parse(txt); transport = 'fetch'; return j; }
      catch (e) { if (r.status === 429) return { code: 429 }; throw new Error('Unexpected response (' + r.status + ')'); }
    });
  }, function (e) {
    clearTimeout(t);
    if (transport === null && e && e.name === 'TypeError') { transport = 'jsonp'; return jsonp(u, 15000); }
    throw e;
  });
}
async function oba(path, params) {
  var gap = S.key === 'TEST' ? 650 : 150, wait = lastCall + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  var u = new URL(CFG.base + path);
  u.searchParams.set('key', S.key);
  Object.keys(params || {}).forEach(function (k) { u.searchParams.set(k, params[k]); });
  var lastErr = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var body = await rawGet(u);
      if (body && typeof body.currentTime === 'number' && body.currentTime > 1e12) S.offset = body.currentTime - Date.now();
      var code = body && body.code;
      if (code === 200) { noteStops(body.data && body.data.references); return body.data || {}; }
      if (code === 429) { lastErr = new Error('Sound Transit is busy (rate limit). Retrying…'); await sleep(1500 * (attempt + 1)); continue; }
      if (code === 401) { var e1 = new Error('The API key was rejected. Check it in Settings.'); e1.fatal = true; throw e1; }
      if (code === 404) { var e2 = new Error('Not found: ' + path); e2.fatal = true; e2.notFound = true; throw e2; }
      throw new Error((body && body.text) || ('Error ' + code));
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e; await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr || new Error('Could not reach Sound Transit');
}
function indexRefs(refs) {
  var o = { trips: {}, stops: {}, routes: {}, situations: [] };
  refs = refs || {};
  (refs.trips || []).forEach(function (t) { o.trips[t.id] = t; });
  (refs.stops || []).forEach(function (s) { o.stops[s.id] = s; });
  (refs.routes || []).forEach(function (r) { o.routes[r.id] = r; });
  o.situations = refs.situations || [];
  return o;
}
function noteStops(refs) {
  ((refs && refs.stops) || []).forEach(function (s) { S.stopInfo[s.id] = { name: s.name, lat: s.lat, lon: s.lon }; });
}

/* ================= track geometry ================= */
function decodePolyline(str) {
  var pts = [], i = 0, lat = 0, lng = 0;
  while (str && i < str.length) {
    var b, shift = 0, res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
    lat += (res & 1) ? ~(res >> 1) : (res >> 1);
    shift = 0; res = 0;
    do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
    lng += (res & 1) ? ~(res >> 1) : (res >> 1);
    pts.push([Math.round(lat) / 1e5, Math.round(lng) / 1e5]);
  }
  return pts;
}
function mkShape(pts) {
  var cum = [0];
  for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }));
  return { pts: pts, cum: cum, len: cum[cum.length - 1] || 0 };
}
function shapeById(id) {
  var L = S.line; if (!L) return null;
  var sh = L.shapes[id];
  if (sh && !sh.cum) { var m = mkShape(sh.pts); sh.cum = m.cum; sh.len = m.len; }
  return sh || null;
}
function pointAt(sh, s) {
  var c = sh.cum, n = c.length;
  s = clamp(s, 0, sh.len);
  var lo = 0, hi = n - 1;
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
  var seg = c[hi] - c[lo] || 1, f = (s - c[lo]) / seg, a = sh.pts[lo], b = sh.pts[hi];
  var lat = a[0] + (b[0] - a[0]) * f, lon = a[1] + (b[1] - a[1]) * f;
  var brg = Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI;
  return { lat: lat, lon: lon, brg: brg };
}
function project(sh, p) {
  var lat0 = p.lat * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540, best = Infinity, bs = 0;
  for (var i = 1; i < sh.pts.length; i++) {
    var a = sh.pts[i - 1], b = sh.pts[i];
    var ax = (a[1] - p.lon) * kx, ay = (a[0] - p.lat) * ky, bx = (b[1] - p.lon) * kx, by = (b[0] - p.lat) * ky;
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? clamp(-(ax * dx + ay * dy) / l2, 0, 1) : 0;
    var x = ax + dx * t, y = ay + dy * t, d = x * x + y * y;
    if (d < best) { best = d; bs = sh.cum[i - 1] + (sh.cum[i] - sh.cum[i - 1]) * t; }
  }
  return { s: bs, d: Math.sqrt(best) };
}

/* ================= the line: stations, platforms, track ================= */
function stationIdx(name) {
  if (!S.line) return -1;
  for (var i = 0; i < S.line.stations.length; i++) if (S.line.stations[i].name === name) return i;
  return -1;
}
function stationOfStop(stopId) {
  var L = S.line; if (!L) return -1;
  if (L.stopIdx[stopId] != null) return L.stopIdx[stopId];
  var info = S.stopInfo[stopId]; if (!info) return -1;
  var best = -1, bd = 450;
  L.stations.forEach(function (st, i) { var d = dist(st, info); if (d < bd) { bd = d; best = i; } });
  L.stopIdx[stopId] = best;
  return best;
}
function tripDir() {   // 'up' = toward Lynnwood (higher station index)
  var a = stationIdx(S.from), b = stationIdx(S.to);
  return b > a ? 'up' : 'down';
}
function finishLine(L) {
  L.stopIdx = {};
  L.stations.forEach(function (st, i) { if (st.up) L.stopIdx[st.up] = i; if (st.down) L.stopIdx[st.down] = i; });
  S.line = L;
  var up = shapeById(L.shapeUp);
  if (up) L.stations.forEach(function (st) { st.s = project(up, st).s; });
}
function cacheSchedule(tripId, sched, sd, trip) {
  if (!sched || !sched.stopTimes || !sched.stopTimes.length) return;
  S.trips[tripId] = {
    st: sched.stopTimes.map(function (x) { return { id: x.stopId, a: x.arrivalTime, d: x.departureTime, s: x.distanceAlongTrip }; }),
    sd: sd, next: sched.nextTripId || null, prev: sched.previousTripId || null,
    shapeId: trip ? trip.shapeId : null, dirId: trip ? String(trip.directionId) : null, headsign: trip ? trip.tripHeadsign : ''
  };
}
async function loadLine(force) {
  var c = store.get('line', null);
  if (!force && c && c.v === 3 && Date.now() - c.at < 7 * 864e5) { finishLine(c); return null; }
  var r = await oba('trips-for-route/' + CFG.route + '.json', { includeStatus: 'true', includeSchedule: 'true' });
  var refs = indexRefs(r.references), best = { up: null, down: null };
  (r.list || []).forEach(function (e) {
    var trip = refs.trips[e.tripId];
    if (!trip || trip.routeId !== CFG.route || !e.schedule) return;
    cacheSchedule(e.tripId, e.schedule, e.serviceDate, trip);
    var st = e.schedule.stopTimes || [];
    if (st.length < 5) return;
    var first = refs.stops[st[0].stopId], last = refs.stops[st[st.length - 1].stopId];
    if (!first || !last) return;
    var k = dist(last, CFG.north) < 900 ? 'up' : dist(first, CFG.north) < 900 ? 'down' : null;
    if (k && (!best[k] || st.length > best[k].st.length)) best[k] = { id: e.tripId, trip: trip, st: st };
  });
  if (!best.up && !best.down) {
    if (c) { finishLine(c); return r; }
    throw new Error('The 2 Line isn\'t running right now, so the line can\'t be drawn yet. Try again during service hours.');
  }
  var stations = [];
  if (best.up) {
    best.up.st.forEach(function (x) { var s = refs.stops[x.stopId]; if (s && !stations.some(function (q) { return q.name === s.name; })) stations.push({ name: s.name, lat: s.lat, lon: s.lon, up: x.stopId, down: null }); });
  } else {
    best.down.st.slice().reverse().forEach(function (x) { var s = refs.stops[x.stopId]; if (s && !stations.some(function (q) { return q.name === s.name; })) stations.push({ name: s.name, lat: s.lat, lon: s.lon, up: null, down: null }); });
  }
  if (best.down) best.down.st.forEach(function (x) {
    var s = refs.stops[x.stopId]; if (!s) return;
    var i = -1, bd = 450;
    stations.forEach(function (q, j) { if (q.name === s.name) { i = j; bd = -1; } else if (bd >= 0) { var d = dist(q, s); if (d < bd) { bd = d; i = j; } } });
    if (i >= 0 && !stations[i].down) stations[i].down = x.stopId;
  });
  var L = { v: 3, at: Date.now(), stations: stations, shapes: {},
    dirUp: best.up ? String(best.up.trip.directionId) : (best.down ? String(1 - Number(best.down.trip.directionId)) : '1'),
    dirDown: best.down ? String(best.down.trip.directionId) : (best.up ? String(1 - Number(best.up.trip.directionId)) : '0'),
    shapeUp: best.up ? best.up.trip.shapeId : null, shapeDown: best.down ? best.down.trip.shapeId : null };
  var ids = [L.shapeUp, L.shapeDown].filter(Boolean);
  for (var i = 0; i < ids.length; i++) {
    var sh = await oba('shape/' + encodeURIComponent(ids[i]) + '.json', {});
    L.shapes[ids[i]] = { pts: decodePolyline(sh.entry && sh.entry.points) };
  }
  if (!L.shapeUp && L.shapeDown) { L.shapeUp = L.shapeDown + '~rev'; L.shapes[L.shapeUp] = { pts: L.shapes[L.shapeDown].pts.slice().reverse() }; }
  store.set('line', { v: 3, at: L.at, stations: L.stations, shapes: (function () { var o = {}; Object.keys(L.shapes).forEach(function (k) { o[k] = { pts: L.shapes[k].pts }; }); return o; })(), dirUp: L.dirUp, dirDown: L.dirDown, shapeUp: L.shapeUp, shapeDown: L.shapeDown });
  finishLine(L);
  return r;
}
async function ensureShape(id) {
  if (!id || !S.line || S.line.shapes[id] || ensureShape.pending[id]) return;
  ensureShape.pending[id] = 1;
  try { var sh = await oba('shape/' + encodeURIComponent(id) + '.json', {}); S.line.shapes[id] = { pts: decodePolyline(sh.entry && sh.entry.points) }; }
  catch (e) { /* fall back to the main track shape */ }
}
ensureShape.pending = {};

/* ================= live trains ================= */
function schedS(tt, tau) {   // distance along the trip at schedule time tau, easing in and out of each station
  var st = tt.st, n = st.length;
  if (tau <= st[0].d) return st[0].s;
  for (var k = 1; k < n; k++) {
    if (tau < st[k].a) {
      var dep = st[k - 1].d, f = clamp((tau - dep) / Math.max(1, st[k].a - dep), 0, 1);
      f = f * f * (3 - 2 * f);
      return st[k - 1].s + (st[k].s - st[k - 1].s) * f;
    }
    if (tau <= st[k].d) return st[k].s;
  }
  return st[n - 1].s;
}
function vehShape(v) {
  var L = S.line; if (!L) return null;
  var tt = S.trips[v.tripId], id = (tt && tt.shapeId) || v.shapeId;
  var sh = id && shapeById(id);
  if (sh) return sh;
  if (id) ensureShape(id);
  return shapeById(v.dirId === L.dirDown && L.shapeDown ? L.shapeDown : L.shapeUp);
}
function modelS(v, t) {
  var tt = S.trips[v.tripId]; if (!tt) return null;
  return schedS(tt, (t - tt.sd) / 1000 - v.dev);
}
function reconcile(v, t) {
  var m = modelS(v, t);
  if (m == null) return;
  v.offset = 0;
  if (v.predicted && v.sObs != null) { var d = v.sObs - m; if (Math.abs(d) > 250) v.offset = clamp(d, -3000, 3000); }
  var target = m + v.offset;
  v.corr = v.lastS == null ? 0 : clamp(v.lastS - target, -1500, 1500);
  v.tObs = t;
}
function ingest(r) {
  var refs = indexRefs(r.references), seen = {}, t = now();
  (r.list || []).forEach(function (e) {
    var tr0 = refs.trips[e.tripId];
    if (e.schedule && tr0 && tr0.routeId === CFG.route && !S.trips[e.tripId]) cacheSchedule(e.tripId, e.schedule, e.serviceDate, tr0);
    var st = e.status; if (!st) return;
    var tid = st.activeTripId || e.tripId, trip = refs.trips[tid];
    if (!trip || trip.routeId !== CFG.route) return;      // the same trains also run 1 Line trips; skip those
    if (seen[tid] || /deadhead/i.test(st.phase || '') || /cancel/i.test(st.status || '')) return;
    var pos = st.position || st.lastKnownLocation;
    if (!pos) return;
    seen[tid] = 1;
    var v = S.veh[tid] || (S.veh[tid] = { tripId: tid, lastS: null, corr: 0, offset: 0, tObs: 0, el: null, lv: null });
    v.headsign = trip.tripHeadsign || ''; v.dirId = String(trip.directionId); v.shapeId = trip.shapeId;
    v.predicted = !!st.predicted; v.dev = st.scheduleDeviation || 0;
    v.sObs = st.distanceAlongTrip; v.total = st.totalDistanceAlongTrip; v.pos = { lat: pos.lat, lon: pos.lon };
    v.phase = String(st.phase || ''); v.gpsAt = st.lastLocationUpdateTime || st.lastUpdateTime || 0; v.vehicleId = st.vehicleId || '';
    reconcile(v, t);
  });
  Object.keys(S.veh).forEach(function (k) { if (!seen[k]) { removeVehicleUI(S.veh[k]); delete S.veh[k]; } });
}
async function fetchTrip(tripId) {
  if (!tripId || S.trips[tripId] || fetchTrip.pending[tripId]) return;
  fetchTrip.pending[tripId] = 1;
  try {
    var r = await oba('trip-details/' + encodeURIComponent(tripId) + '.json', { includeSchedule: 'true', includeTrip: 'true', includeStatus: 'false' });
    var refs = indexRefs(r.references), e = r.entry || {};
    cacheSchedule(tripId, e.schedule, e.serviceDate, refs.trips[tripId]);
    if (S.veh[tripId]) reconcile(S.veh[tripId], now());
  } finally { delete fetchTrip.pending[tripId]; }
}
fetchTrip.pending = {};
function isUp(dirId) { return S.line && dirId === S.line.dirUp; }
// Where a train is drawn right now: smooth, on the track, between updates.
function locateTrain(v, t) {
  var sh = vehShape(v); if (!sh) return null;
  var tt = S.trips[v.tripId], s;
  var m = tt ? modelS(v, t) : null;
  if (m != null) {
    s = m + v.offset + v.corr * Math.exp(-(t - v.tObs) / 6000);
    var tot = v.total || tt.st[tt.st.length - 1].s || sh.len;
    v.lastS = s;
    s = s * (sh.len / (tot || sh.len));
  } else {
    s = project(sh, v.pos).s;
    v.lastS = null;
  }
  return pointAt(sh, s);
}

/* ================= your departures ================= */
function arrKey() { return S.from + '>' + S.to; }
async function loadArrivals() {
  var L = S.line, a = stationIdx(S.from), b = stationIdx(S.to);
  if (!L || a < 0 || b < 0) return;
  var up = b > a, st = L.stations[a], stopId = up ? (st.up || st.down) : (st.down || st.up);
  var wantDir = up ? L.dirUp : L.dirDown;
  var r = await oba('arrivals-and-departures-for-stop/' + encodeURIComponent(stopId) + '.json', { minutesBefore: 1, minutesAfter: 120 });
  var refs = indexRefs(r.references), t = now();
  var list = ((r.entry && r.entry.arrivalsAndDepartures) || []).filter(function (x) {
    if (x.routeId !== CFG.route || x.departureEnabled === false) return false;
    var tr = refs.trips[x.tripId];
    return !tr || tr.directionId == null || String(tr.directionId) === wantDir;
  }).map(function (x) {
    var live = x.predicted === true && ((x.predictedDepartureTime || 0) > 0 || (x.predictedArrivalTime || 0) > 0);
    var sched = x.scheduledDepartureTime || x.scheduledArrivalTime, pred = live ? (x.predictedDepartureTime || x.predictedArrivalTime) : 0;
    var ts = x.tripStatus || {};
    return { tripId: x.tripId, t: pred || sched, sched: sched, live: live, dev: live ? Math.round((pred - sched) / 1000) : 0,
      stopsAway: typeof x.numberOfStopsAway === 'number' ? x.numberOfStopsAway : null,
      canceled: /cancel/i.test(String(ts.status || '') + ' ' + String(x.status || '')) };
  }).filter(function (x) { return x.t >= t - 60000; }).sort(function (p, q) { return p.t - q.t; }).slice(0, 8);
  S.arr = { key: arrKey(), at: t, list: list };
  S.alerts = refs.situations.filter(function (s) { return s && s.summary && s.summary.value; });
  for (var i = 0; i < Math.min(3, list.length); i++) { try { await fetchTrip(list[i].tripId); } catch (e) { /* keep going */ } }
}
function nextTrain() {
  if (!S.arr || S.arr.key !== arrKey()) return null;
  return S.arr.list.filter(function (x) { return !x.canceled && x.t >= now() - 30000; })[0] || null;
}
function arriveAt(x) {
  var tt = S.trips[x.tripId], b = stationIdx(S.to), a = stationIdx(S.from);
  if (!tt) return null;
  var seenFrom = false;
  for (var i = 0; i < tt.st.length; i++) {
    var k = stationOfStop(tt.st[i].id);
    if (k === a) seenFrom = true;
    else if (k === b && seenFrom) return tt.sd + (tt.st[i].a + x.dev) * 1000;
  }
  return null;
}
function yourVehicle() {
  var y = nextTrain(); if (!y) return null;
  if (S.veh[y.tripId]) return { v: S.veh[y.tripId], prior: false };
  for (var k in S.veh) { var tt = S.trips[k]; if (tt && tt.next === y.tripId) return { v: S.veh[k], prior: true }; }
  return null;
}

/* ================= map ================= */
var map = null, mapReady = false, meMarker = null;
function styleUrl() { return isDark() ? CFG.styleDark : CFG.styleLight; }
function initMap() {
  if (map || !window.maplibregl) return;
  var b = tripBounds();
  map = new maplibregl.Map({
    container: 'map', style: styleUrl(), attributionControl: { compact: true },
    bounds: b || [[-122.33, 47.6], [-122.1, 47.83]], fitBoundsOptions: { padding: 40 },
    dragRotate: false, pitchWithRotate: false, touchPitch: false, maxZoom: 17.5, minZoom: 8, fadeDuration: 120
  });
  map.touchZoomRotate.disableRotation();
  map.on('style.load', function () { tidyStyle(); addOverlays(); mapReady = true; applyPadding(); });
  map.on('dragstart', function () { if (S.follow) { S.follow = false; renderSheet(); } });
  map.on('click', function (e) {
    var tg = e.originalEvent && e.originalEvent.target;
    if (tg && tg.closest && tg.closest('.maplibregl-marker')) return;
    if (S.selected) { S.selected = null; renderSheet(); }
  });
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (map) { mapReady = false; map.setStyle(styleUrl(), { diff: false }); } });
}
function tidyStyle() {
  var keep = /^(place_city|place_city_large|place_town|label_city|label_city_capital|label_town)$/;
  (map.getStyle().layers || []).forEach(function (l) {
    try {
      if (l.type === 'symbol' && !keep.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
      if (/railway|aeroway/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
      if (l.type === 'line' && /^highway_(minor|path)|^road/.test(l.id)) map.setPaintProperty(l.id, 'line-opacity', 0.55);
    } catch (e) { /* layer without that property */ }
  });
}
function lineGeo(sh) { return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: sh ? sh.pts.map(function (p) { return [p[1], p[0]]; }) : [] } }; }
function tripGeo() {
  var L = S.line, sh = L && shapeById(L.shapeUp), a = stationIdx(S.from), b = stationIdx(S.to);
  if (!sh || a < 0 || b < 0) return lineGeo(null);
  var s0 = Math.min(L.stations[a].s, L.stations[b].s), s1 = Math.max(L.stations[a].s, L.stations[b].s), pts = [];
  var p0 = pointAt(sh, s0); pts.push([p0.lon, p0.lat]);
  for (var i = 0; i < sh.pts.length; i++) if (sh.cum[i] > s0 && sh.cum[i] < s1) pts.push([sh.pts[i][1], sh.pts[i][0]]);
  var p1 = pointAt(sh, s1); pts.push([p1.lon, p1.lat]);
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } };
}
function stationsGeo() {
  var L = S.line; if (!L) return { type: 'FeatureCollection', features: [] };
  var a = stationIdx(S.from), b = stationIdx(S.to), lo = Math.min(a, b), hi = Math.max(a, b);
  return { type: 'FeatureCollection', features: L.stations.map(function (st, i) {
    return { type: 'Feature', properties: { name: st.name, end: (i === a || i === b) ? 1 : 0, mine: (a >= 0 && i >= lo && i <= hi) ? 1 : 0 }, geometry: { type: 'Point', coordinates: [st.lon, st.lat] } };
  }) };
}
function meGeo() {
  if (!S.me) return { type: 'FeatureCollection', features: [] };
  var pts = [], r = Math.max(S.me.acc || 0, 5), k = 111320 * Math.cos(S.me.lat * Math.PI / 180);
  for (var i = 0; i <= 48; i++) { var an = i / 48 * 2 * Math.PI; pts.push([S.me.lon + Math.cos(an) * r / k, S.me.lat + Math.sin(an) * r / 110540]); }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } }] };
}
function addOverlays() {
  if (!map || !S.line) return;
  var line = cssVar('--line') || '#0A7FC2', dark = isDark(), text = dark ? '#F2F2F7' : '#1C1C1E', halo = dark ? '#000000' : '#FFFFFF';
  var font = ['Noto Sans Regular'];
  function src(id, data) { if (map.getSource(id)) map.getSource(id).setData(data); else map.addSource(id, { type: 'geojson', data: data }); }
  src('lt-route', lineGeo(shapeById(S.line.shapeUp)));
  src('lt-trip', tripGeo());
  src('lt-stations', stationsGeo());
  src('lt-me', meGeo());
  function layer(def) { if (!map.getLayer(def.id)) map.addLayer(def); }
  layer({ id: 'lt-me-acc', type: 'fill', source: 'lt-me', paint: { 'fill-color': '#0A84FF', 'fill-opacity': 0.12 } });
  layer({ id: 'lt-route-case', type: 'line', source: 'lt-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': halo, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 15, 11], 'line-opacity': 0.85 } });
  layer({ id: 'lt-route', type: 'line', source: 'lt-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': line, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 15, 6], 'line-opacity': 0.45 } });
  layer({ id: 'lt-trip', type: 'line', source: 'lt-trip', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': line, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 4, 15, 8] } });
  layer({ id: 'lt-st', type: 'circle', source: 'lt-stations', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['==', ['get', 'end'], 1], 5, 2.5], 15, ['case', ['==', ['get', 'end'], 1], 8, 5.5]],
    'circle-color': ['case', ['==', ['get', 'end'], 1], line, halo],
    'circle-stroke-color': ['case', ['==', ['get', 'end'], 1], halo, ['case', ['==', ['get', 'mine'], 1], line, cssVar('--label3') || '#999']],
    'circle-stroke-width': ['case', ['==', ['get', 'end'], 1], 3, 2] } });
  layer({ id: 'lt-st-label', type: 'symbol', source: 'lt-stations', minzoom: 11, filter: ['==', ['get', 'end'], 0], layout: {
    'text-field': ['get', 'name'], 'text-font': font, 'text-size': 12, 'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-optional': true, 'symbol-sort-key': ['-', 1, ['get', 'mine']] },
    paint: { 'text-color': text, 'text-opacity': ['case', ['==', ['get', 'mine'], 1], 1, 0.6], 'text-halo-color': halo, 'text-halo-width': 1.6 } });
  layer({ id: 'lt-st-label-end', type: 'symbol', source: 'lt-stations', filter: ['==', ['get', 'end'], 1], layout: {
    'text-field': ['get', 'name'], 'text-font': font, 'text-size': 13.5, 'text-anchor': 'left', 'text-offset': [1, 0], 'text-allow-overlap': true },
    paint: { 'text-color': text, 'text-halo-color': halo, 'text-halo-width': 2 } });
}
function refreshOverlays() {
  if (!map || !mapReady || !S.line) return;
  if (!map.getSource('lt-route')) { addOverlays(); return; }
  map.getSource('lt-trip').setData(tripGeo());
  map.getSource('lt-stations').setData(stationsGeo());
}
function tripBounds() {
  var L = S.line, a = stationIdx(S.from), b = stationIdx(S.to);
  if (!L || a < 0 || b < 0) return null;
  var pts = [L.stations[a], L.stations[b]];
  return [[Math.min(pts[0].lon, pts[1].lon), Math.min(pts[0].lat, pts[1].lat)], [Math.max(pts[0].lon, pts[1].lon), Math.max(pts[0].lat, pts[1].lat)]];
}
function topInset() { var t = $('.top'); return t ? t.getBoundingClientRect().bottom + 8 : 70; }
function applyPadding() {
  if (!map) return;
  map.setPadding({ top: topInset(), bottom: sheetVisible() + 12, left: 12, right: 64 });
}
function fitTrip(animate) {
  if (!map) return;
  var b = tripBounds(); if (!b) return;
  var y = yourVehicle(), pts = [b[0], b[1]];
  if (y && y.v.cur) pts.push([y.v.cur.lon, y.v.cur.lat]);
  var minX = Math.min.apply(null, pts.map(function (p) { return p[0]; })), maxX = Math.max.apply(null, pts.map(function (p) { return p[0]; }));
  var minY = Math.min.apply(null, pts.map(function (p) { return p[1]; })), maxY = Math.max.apply(null, pts.map(function (p) { return p[1]; }));
  map.fitBounds([[minX, minY], [maxX, maxY]], { padding: { top: topInset() + 30, bottom: sheetVisible() + 40, left: 40, right: 90 }, maxZoom: 14.5, duration: animate ? 900 : 0 });
}
function trainEl(v) {
  var outer = document.createElement('div'), el = document.createElement('div');
  el.className = 'tr';
  el.innerHTML = '<div class="arr"></div><div class="body">2</div>';
  outer.appendChild(el);
  outer.setAttribute('role', 'button');
  outer.setAttribute('aria-label', '2 Line train to ' + (v.headsign || ''));
  outer.addEventListener('click', function (e) { e.stopPropagation(); select(v.tripId); });
  v.el = el;
  return outer;
}
function removeVehicleUI(v) {
  if (v.marker) { v.marker.remove(); v.marker = null; }
  if (v.lv && v.lv.parentNode) v.lv.parentNode.removeChild(v.lv);
}
function updateMe() {
  if (!map || !S.me) return;
  if (!meMarker) {
    var el = document.createElement('div'); el.className = 'me'; el.setAttribute('aria-label', 'Your location');
    meMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([S.me.lon, S.me.lat]).addTo(map);
  } else meMarker.setLngLat([S.me.lon, S.me.lat]);
  if (mapReady && map.getSource('lt-me')) map.getSource('lt-me').setData(meGeo());
}

/* ================= animation loop (runs at the screen's refresh rate) ================= */
var lastFrameSig = {};
function frame() {
  var t = now(), y = yourVehicle(), dirUp = tripDir() === 'up';
  var yourId = y ? y.v.tripId : null;
  for (var k in S.veh) {
    var v = S.veh[k], p = locateTrain(v, t);
    if (!p) continue;
    v.cur = p;
    if (map && S.view === 'map') {
      var cls = 'tr' + (k === yourId ? ' you' : '') + (v.predicted ? '' : ' nogps') + (isUp(v.dirId) === dirUp || k === yourId ? '' : ' other') + (S.selected === k ? ' sel' : '');
      if (!v.marker) { v.marker = new maplibregl.Marker({ element: trainEl(v), anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(map); lastFrameSig[k] = null; }
      else v.marker.setLngLat([p.lon, p.lat]);
      if (v.el.className !== cls) {
        v.el.className = cls;
        v.marker.getElement().style.zIndex = k === yourId ? 3 : S.selected === k ? 2 : 1;
        var tag = v.el.querySelector('.tag');
        if (k === yourId && !tag) { tag = document.createElement('div'); tag.className = 'tag'; v.el.appendChild(tag); updateTag(); }
        if (k !== yourId && tag) tag.remove();
      }
      var arr = v.el.firstChild, deg = Math.round(p.brg);
      if (lastFrameSig[k] !== deg) { arr.style.transform = 'rotate(' + deg + 'deg)'; lastFrameSig[k] = deg; }
    }
  }
  if (map && S.view === 'map' && S.follow) {
    var f = S.selected && S.veh[S.selected] ? S.veh[S.selected] : y && y.v;
    if (f && f.cur) map.jumpTo({ center: [f.cur.lon, f.cur.lat] });
  }
  if (S.view === 'line') lineFrame(t, yourId);
  requestAnimationFrame(frame);
}
function updateTag() {
  var y = yourVehicle(), n = nextTrain();
  if (!y || !n || !y.v.el) return;
  var tag = y.v.el.querySelector('.tag'); if (!tag) return;
  var m = Math.round((n.t - now()) / 60000);
  tag.textContent = 'Your train · ' + (m <= 0 ? 'now' : m + ' min');
}

/* ================= bottom sheet ================= */
var sheet, sheetBody;
function detentHeights() {
  var H = sheet.getBoundingClientRect().height || window.innerHeight * 0.92;
  return { peek: Math.min(206, H), mid: Math.round(Math.min(H, window.innerHeight * 0.52)), full: H };
}
function sheetVisible() { if (!sheet) return 0; var h = detentHeights(); return h[S.detent] || h.mid; }
function setDetent(d, quiet) {
  S.detent = d;
  document.body.classList.toggle('sheet-full', d === 'full');
  var h = detentHeights(), H = sheet.getBoundingClientRect().height;
  sheet.style.transform = 'translateY(' + Math.round(H - h[d]) + 'px)';
  document.documentElement.style.setProperty('--sheet-h', h[d] + 'px');
  if (!quiet) setTimeout(applyPadding, 60);
}
function initSheet() {
  sheet = $('#sheet'); sheetBody = $('#sheetBody');
  var startY = 0, startT = 0, base = 0, moved = false, lastY = 0, lastT = 0, vel = 0, active = false, onGrab = false;
  function cur() { var m = /translateY\((-?[\d.]+)px\)/.exec(sheet.style.transform || ''); return m ? Number(m[1]) : 0; }
  sheet.addEventListener('pointerdown', function (e) {
    if (!e.target.closest('.drag-zone') || e.target.closest('button,a,input,summary')) return;
    active = true; moved = false; onGrab = !!e.target.closest('.grab'); startY = lastY = e.clientY; startT = lastT = performance.now(); base = cur(); vel = 0;
    sheet.classList.add('dragging');
    try { sheet.setPointerCapture(e.pointerId); } catch (x) { /* older browsers */ }
  });
  sheet.addEventListener('pointermove', function (e) {
    if (!active) return;
    var dy = e.clientY - startY; if (Math.abs(dy) > 4) moved = true;
    var H = sheet.getBoundingClientRect().height, y = clamp(base + dy, 0, H - 120);
    sheet.style.transform = 'translateY(' + y + 'px)';
    var tn = performance.now(); vel = (e.clientY - lastY) / Math.max(1, tn - lastT); lastY = e.clientY; lastT = tn;
  });
  function end() {
    if (!active) return; active = false; sheet.classList.remove('dragging');
    var h = detentHeights(), H = sheet.getBoundingClientRect().height;
    if (!moved) { if (onGrab) setDetent(S.detent === 'peek' ? 'mid' : S.detent === 'mid' ? 'full' : 'mid'); return; }
    var y = cur() + vel * 160, best = 'mid', bd = Infinity;
    ['peek', 'mid', 'full'].forEach(function (d) { var dd = Math.abs(H - h[d] - y); if (dd < bd) { bd = dd; best = d; } });
    setDetent(best);
  }
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
  window.addEventListener('resize', function () { setDetent(S.detent, true); applyPadding(); });
  setDetent('mid', true);
}
function chip(dev, live, canceled) {
  if (canceled) return '<span class="chip cancel">Canceled</span>';
  if (!live) return '<span class="chip sched">Scheduled</span>';
  var m = Math.round(dev / 60);
  if (m === 0) return '<span class="chip ok"><i></i>On time</span>';
  if (m > 0) return '<span class="chip late"><i></i>' + m + ' min late</span>';
  return '<span class="chip early"><i></i>' + (-m) + ' min early</span>';
}
function cdHTML(t) { return '<span data-cd="' + t + '"></span>'; }
function minsText(t) {
  var m = Math.round((t - now()) / 60000);
  if (m <= 0) return { n: 'Now', u: '' };
  if (m >= 60) return { n: Math.floor(m / 60) + 'h', u: (m % 60) + 'm' };
  return { n: String(m), u: 'min' };
}
function whereText(v) {
  var L = S.line; if (!L || !v.cur) return '';
  var up = shapeById(L.shapeUp); if (!up) return '';
  var s = project(up, v.cur).s, st = L.stations, n = st.length, i;
  for (i = 0; i < n; i++) if (Math.abs(st[i].s - s) < 130) return 'at <b>' + esc(st[i].name) + '</b>';
  for (i = 0; i < n - 1; i++) {
    var a = Math.min(st[i].s, st[i + 1].s), b = Math.max(st[i].s, st[i + 1].s);
    if (s > a && s < b) {
      var goingUp = isUp(v.dirId), from = goingUp ? st[i] : st[i + 1], to = goingUp ? st[i + 1] : st[i];
      return 'between <b>' + esc(from.name) + '</b> and <b>' + esc(to.name) + '</b>';
    }
  }
  return 'near <b>' + esc(st[s < st[0].s ? 0 : n - 1].name) + '</b>';
}
var CHEV = '<svg class="chev" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5L6.5 6.5L1.5 11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function renderSheet() {
  if (!sheetBody) return;
  if (S.selected && S.veh[S.selected]) { renderDetail(S.veh[S.selected]); return; }
  S.selected = null;
  var html = '', n = nextTrain(), y = yourVehicle();
  if (!S.line || !S.from || !S.to) {
    html = '<div class="drag-zone"><div class="skel" style="height:56px"></div><div class="skel" style="height:44px;margin-top:12px"></div></div>';
  } else if (!S.arr || S.arr.key !== arrKey()) {
    html = '<div class="drag-zone"><div class="skel" style="height:56px"></div><div class="skel" style="height:44px;margin-top:12px"></div></div>';
  } else if (!n) {
    html = '<div class="drag-zone"><div class="empty">No 2 Line trains from ' + esc(S.from) + ' toward ' + esc(S.to) + ' in the next 2 hours.</div></div>';
  } else {
    var arrive = arriveAt(n);
    html += '<div class="drag-zone"><div class="hero"><div class="count num' + (n.live ? ' live' : '') + '" data-cdbig="' + n.t + '"></div>' +
      '<div class="hero-info"><div class="hero-title">To ' + esc(S.to) + '</div><div class="hero-sub">' + chip(n.dev, n.live, false) +
      ' <span class="num">' + clock(n.t) + (arrive ? ' → ' + clock(arrive) : '') + '</span></div></div></div>';
    var wh, est = !(y && y.v.predicted);
    if (y && y.v.cur) {
      var w = whereText(y.v);
      if (y.prior) wh = /^at /.test(w) ? 'Your train is ' + w + ', getting ready to leave' : 'Your train is finishing another trip, now ' + w;
      else wh = (y.v.predicted ? 'Your train is ' : 'Estimated: your train is ') + w + (n.stopsAway > 0 ? ' · ' + n.stopsAway + (n.stopsAway === 1 ? ' stop away' : ' stops away') : '');
    }
    else wh = 'Your train hasn\'t started its trip yet.';
    html += '<div class="where' + (est ? ' est' : '') + '"><span class="pin"></span><span>' + wh + '</span>' +
      (y && y.v.cur ? '<button class="pill-btn' + (S.follow && !S.selected ? '' : ' tinted') + '" type="button" data-act="follow">' + (S.follow && !S.selected ? 'Following' : 'Follow') + '</button>' : '') + '</div></div>';
  }
  if (S.alerts.length) {
    var al = S.alerts[0];
    html += '<details class="alert"><summary>⚠︎ ' + esc(al.summary.value) + (S.alerts.length > 1 ? ' (+' + (S.alerts.length - 1) + ' more)' : '') + '</summary>' +
      S.alerts.slice(0, 3).map(function (s) { return '<p>' + esc((s.description && s.description.value) || s.summary.value) + '</p>'; }).join('') + '</details>';
  }
  html += '<div class="sec">Trip</div><div class="trip-wrap"><div class="group trip">' +
    '<button class="cell" type="button" data-act="pick-from"><span class="dot-o"></span><span class="k">From</span><span class="v">' + esc(S.from || 'Choose a station') + '</span>' + CHEV + '</button>' +
    '<button class="cell" type="button" data-act="pick-to"><span class="dot-d"></span><span class="k">To</span><span class="v">' + esc(S.to || 'Choose a station') + '</span>' + CHEV + '</button></div>' +
    '<button class="swap" type="button" data-act="swap" aria-label="Swap direction"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M21 16l-4 4-4-4"/></svg></button></div>';
  if (S.arr && S.arr.key === arrKey() && S.arr.list.length > 1) {
    html += '<div class="sec"><span>Departures</span><span style="text-transform:none">' + esc(S.from) + '</span></div><div class="group">';
    S.arr.list.slice(0, 7).forEach(function (x) {
      var ar = arriveAt(x);
      html += '<div class="dep' + (x.canceled ? ' canceled' : '') + '"><div class="t num">' + clock(x.t) + '<small>' + (ar ? 'Arrives ' + clock(ar) : '&nbsp;') + '</small></div>' +
        '<div class="m">' + chip(x.dev, x.live, x.canceled) + '</div><div class="mins num">' + (x.canceled ? '–' : cdHTML(x.t)) + '</div></div>';
    });
    html += '</div>';
  }
  html += '<p class="foot">Live positions from Sound Transit. Trains glide along the track between updates using the timetable and each train\'s current delay. Tap any train for its next stops.</p>';
  sheetBody.innerHTML = html;
  tickTexts();
}
function renderDetail(v) {
  var tt = S.trips[v.tripId], t = now(), html = '';
  html += '<div class="drag-zone"><div class="d-head"><div class="d-badge">2</div><div class="d-title"><h2>To ' + esc(v.headsign || '') + '</h2>' +
    '<div>' + (v.predicted ? 'Live GPS' + (v.gpsAt ? ' · updated <span data-ago="' + v.gpsAt + '"></span>' : '') : 'Estimated from the timetable') + '</div></div>' +
    '<button class="close" type="button" data-act="close" aria-label="Close"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>' +
    '<div class="where' + (v.predicted ? '' : ' est') + '"><span class="pin"></span><span>' + chip(v.dev, v.predicted, false) + ' Now ' + whereText(v) + '</span>' +
    '<button class="pill-btn' + (S.follow ? '' : ' tinted') + '" type="button" data-act="follow">' + (S.follow ? 'Following' : 'Follow') + '</button></div></div>';
  if (tt) {
    var tau = (t - tt.sd) / 1000 - v.dev, a = stationIdx(S.from), b = stationIdx(S.to), rows = '';
    tt.st.forEach(function (x) {
      if (x.a + 20 < tau) return;
      var k = stationOfStop(x.id), name = k >= 0 ? S.line.stations[k].name : ((S.stopInfo[x.id] || {}).name || 'Stop');
      var eta = tt.sd + (x.a + v.dev) * 1000;
      rows += '<div class="cell' + (k === a || k === b ? ' mine' : '') + '"><span class="tl"></span><span class="v">' + esc(name) + '</span><span class="r num">' + cdHTML(eta) + ' · ' + clock(eta) + '</span></div>';
    });
    html += '<div class="sec">Next stops</div><div class="group stops">' + (rows || '<div class="empty">This train has finished its trip.</div>') + '</div>';
  } else html += '<div class="sec">Next stops</div><div class="group"><div class="empty">Loading this train\'s stops…</div></div>';
  html += '<p class="foot">' + (v.predicted ? 'Times include this train\'s current delay.' : 'This train isn\'t sending GPS right now, so its position and times come from the timetable.') + '</p>';
  sheetBody.innerHTML = html;
  tickTexts();
  if (!tt) fetchTrip(v.tripId).then(renderSheet, function () {});
}
function tickTexts() {
  document.querySelectorAll('[data-cd]').forEach(function (el) { var m = minsText(Number(el.getAttribute('data-cd'))); el.innerHTML = m.n + (m.u ? '<small>' + m.u + '</small>' : ''); });
  document.querySelectorAll('[data-cdbig]').forEach(function (el) { var m = minsText(Number(el.getAttribute('data-cdbig'))); el.innerHTML = '<b>' + m.n + '</b>' + (m.u ? '<small>' + m.u + '</small>' : ''); });
  document.querySelectorAll('[data-ago]').forEach(function (el) { var s = Math.max(0, Math.round((now() - Number(el.getAttribute('data-ago'))) / 1000)); el.textContent = s < 60 ? s + 's ago' : Math.round(s / 60) + ' min ago'; });
  updateTag(); updateStatus();
}
function select(tripId) {
  S.selected = tripId; S.follow = false;
  if (S.detent === 'peek') setDetent('mid');
  renderSheet();
  var v = S.veh[tripId];
  if (map && v && v.cur) map.easeTo({ center: [v.cur.lon, v.cur.lat], duration: 600 });
}

/* ================= line view ================= */
var ROW = 52, PADY = 16;
function buildDiagram() {
  var d = $('#diagram'), L = S.line;
  if (!L) { d.innerHTML = '<div class="empty">Loading the line…</div>'; return; }
  var n = L.stations.length, a = stationIdx(S.from), b = stationIdx(S.to), lo = Math.min(a, b), hi = Math.max(a, b), up = b > a;
  var H = PADY * 2 + n * ROW, html = '';
  function yOf(i) { return PADY + (n - 1 - i) * ROW + ROW / 2; }
  html += '<div class="rail" style="left:26px;top:' + yOf(n - 1) + 'px;height:' + (yOf(0) - yOf(n - 1)) + 'px"></div>';
  html += '<div class="rail" style="right:26px;top:' + yOf(n - 1) + 'px;height:' + (yOf(0) - yOf(n - 1)) + 'px"></div>';
  if (a >= 0 && b >= 0) html += '<div class="rail hot" style="' + (up ? 'right' : 'left') + ':26px;top:' + yOf(hi) + 'px;height:' + (yOf(lo) - yOf(hi)) + 'px"></div>';
  L.stations.forEach(function (st, i) {
    var mine = a >= 0 && i >= lo && i <= hi, y = yOf(i);
    html += '<div class="srow' + (mine ? ' mine' : '') + '" style="top:' + (y - ROW / 2) + 'px">' + esc(st.name) + (i === a ? '<small>You board</small>' : i === b ? '<small>Your stop</small>' : '') + '</div>';
    html += '<div class="sdot' + (mine && !up ? ' mine' : '') + '" style="left:28px;top:' + y + 'px"></div><div class="sdot' + (mine && up ? ' mine' : '') + '" style="right:22px;top:' + y + 'px;left:auto;margin-right:0"></div>';
  });
  d.style.height = H + 'px';
  d.innerHTML = html;
  for (var k in S.veh) S.veh[k].lv = null;
  $('#lvLead').textContent = (a >= 0 && b >= 0) ? 'Your trip: ' + S.from + ' to ' + S.to : 'Every train, live';
}
function lineFrame(t, yourId) {
  var L = S.line, d = $('#diagram'); if (!L || !d) return;
  var up = shapeById(L.shapeUp); if (!up) return;
  var n = L.stations.length, W = d.clientWidth;
  for (var k in S.veh) {
    var v = S.veh[k]; if (!v.cur) continue;
    if (!v.lv) {
      v.lv = document.createElement('div');
      v.lv.addEventListener('click', (function (id) { return function () { setView('map'); select(id); }; })(k));
      d.appendChild(v.lv);
    }
    var cls = 'lt' + (v.predicted ? '' : ' nogps') + (k === yourId ? ' you' : '');
    if (v.lv.className !== cls) { v.lv.className = cls; v.lv.textContent = isUp(v.dirId) ? '▲' : '▼'; }
    var s = project(up, v.cur).s, fi = 0, st = L.stations;
    if (s <= st[0].s) fi = 0; else if (s >= st[n - 1].s) fi = n - 1;
    else for (var i = 0; i < n - 1; i++) { if (s >= st[i].s && s < st[i + 1].s) { fi = i + (s - st[i].s) / Math.max(1, st[i + 1].s - st[i].s); break; } }
    var x = isUp(v.dirId) ? W - 28 : 28, y = PADY + (n - 1 - fi) * ROW + ROW / 2;
    v.lv.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
  }
}
function setView(view) {
  S.view = view;
  var lv = $('#lineView'), on = view === 'line';
  lv.classList.toggle('off', !on); lv.setAttribute('aria-hidden', String(!on));
  $('#btnLine').setAttribute('aria-pressed', String(on));
  sheet.style.visibility = on ? 'hidden' : '';
  document.body.classList.toggle('line-on', on);
  if (on) buildDiagram();
  else for (var k in S.veh) { var v = S.veh[k]; if (v.lv && v.lv.parentNode) v.lv.parentNode.removeChild(v.lv); v.lv = null; }
}

/* ================= station picker ================= */
var pickWhich = null, pickFirstRun = false;
function openPicker(which, firstRun) {
  pickWhich = which; pickFirstRun = !!firstRun;
  $('#pickTitle').textContent = which === 'from' ? (firstRun ? 'Where are you starting?' : 'Starting Station') : (firstRun ? 'Where are you going?' : 'Destination');
  $('#pickCancel').textContent = firstRun ? 'Skip' : 'Cancel';
  $('#pickSearch').value = '';
  renderPicker();
  $('#picker').classList.add('open');
}
function closePicker() { $('#picker').classList.remove('open'); pickWhich = null; }
function renderPicker() {
  var L = S.line, q = $('#pickSearch').value.trim().toLowerCase(), html = '';
  if (!L) { $('#pickList').innerHTML = '<div class="empty">Loading stations…</div>'; return; }
  var cur = pickWhich === 'from' ? S.from : S.to;
  var nearest = -1;
  if (S.me) { var bd = Infinity; L.stations.forEach(function (st, i) { var dd = dist(st, S.me); if (dd < bd) { bd = dd; nearest = i; } }); }
  if (!q && 'geolocation' in navigator) {
    html += '<div class="sec">&nbsp;</div><div class="group"><button class="cell" type="button" data-near="1"><span class="loc-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.6 3.4a.9.9 0 0 0-1-.2L3.7 10.1a.9.9 0 0 0 .1 1.7l6.6 1.8 1.8 6.6a.9.9 0 0 0 1.7.1l6.9-15.9a.9.9 0 0 0-.2-1z"/></svg></span>' +
      '<span class="v" style="color:var(--blue)">' + (nearest >= 0 ? 'Nearest: ' + esc(L.stations[nearest].name) : 'Use Current Location') + '</span>' +
      (nearest >= 0 ? '<span class="r">' + miles(dist(L.stations[nearest], S.me)) + '</span>' : '') + '</button></div>';
  }
  html += '<div class="sec">2 Line stations</div><div class="group">';
  var rows = L.stations.map(function (st, i) { return { st: st, i: i }; }).reverse().filter(function (o) { return !q || o.st.name.toLowerCase().indexOf(q) >= 0; });
  rows.forEach(function (o) {
    html += '<button class="cell ind-40" type="button" data-st="' + esc(o.st.name) + '"><span class="st-ico">2</span><span class="v">' + esc(o.st.name) +
      (o.i === nearest ? ' <span class="near">Nearest</span>' : '') + '</span>' + (S.me ? '<span class="r num">' + miles(dist(o.st, S.me)) + '</span>' : '') +
      (o.st.name === cur ? '<span class="check">✓</span>' : '') + '</button>';
  });
  if (!rows.length) html += '<div class="empty">No station matches “' + esc(q) + '”.</div>';
  html += '</div>';
  $('#pickList').innerHTML = html;
}
function choose(name) {
  var which = pickWhich, other = which === 'from' ? S.to : S.from;
  if (name === other) { var tmp = S.from; S.from = S.to; S.to = tmp; }
  else if (which === 'from') S.from = name; else S.to = name;
  store.set('from', S.from); store.set('to', S.to);
  closePicker();
  tripChanged();
  if (pickFirstRun && which === 'from' && !S.to) setTimeout(function () { openPicker('to', true); }, 380);
}
function tripChanged() {
  S.arr = null; S.selected = null; S.follow = false;
  refreshOverlays(); renderSheet();
  if (S.view === 'line') buildDiagram();
  if (map) fitTrip(true);
  kick();
}

/* ================= your location ================= */
function startLocate(fly) {
  if (!('geolocation' in navigator)) { toast('Location isn\'t available on this device.'); return; }
  var first = true;
  if (S.meWatch == null) {
    S.meWatch = navigator.geolocation.watchPosition(function (p) {
      S.me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() };
      store.set('locOk', true);
      updateMe();
      $('#btnLocate').setAttribute('aria-pressed', 'true');
      if (pickWhich) renderPicker();
      if (first && fly && map) map.easeTo({ center: [S.me.lon, S.me.lat], zoom: Math.max(map.getZoom(), 14), duration: 800 });
      if (first && pickWhich && fly === 'near') pickNearest();
      first = false;
    }, function (err) {
      S.meWatch = null;
      $('#btnLocate').setAttribute('aria-pressed', 'false');
      toast(err.code === 1 ? 'Location is off for this site. Turn it on in Settings › Privacy › Location Services › Safari Websites.' : 'Couldn\'t get your location right now.');
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  } else if (fly && S.me && map) map.easeTo({ center: [S.me.lon, S.me.lat], zoom: Math.max(map.getZoom(), 14), duration: 700 });
}
function pickNearest() {
  if (!S.me || !S.line) return;
  var best = null, bd = Infinity;
  S.line.stations.forEach(function (st) { var d = dist(st, S.me); if (d < bd) { bd = d; best = st.name; } });
  if (best) choose(best);
}

/* ================= status, refresh, persistence ================= */
var toastTimer = null;
function toast(msg) {
  var t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 4200);
}
function updateStatus() {
  var el = $('#status'), txt = $('#statusText'), age = S.lastOk ? (now() - S.lastOk) / 1000 : Infinity;
  var cls = 'status glass', label;
  if (!S.lastOk) { label = S.err ? 'Offline' : 'Connecting…'; if (S.err) cls += ' err'; }
  else if (S.err && age > S.refreshSec * 2) { cls += ' err'; label = 'Offline · ' + Math.round(age / 60) + 'm ago'; }
  else if (age > S.refreshSec * 3 + 10) { cls += ' warn'; label = 'Updated ' + Math.round(age / 60) + 'm ago'; }
  else { cls += ' ok'; label = 'Live'; }
  if (el.className !== cls) el.className = cls;
  if (txt.textContent !== label) txt.textContent = label;
}
function saveSnap() {
  var keepTrips = {}, veh = {};
  Object.keys(S.veh).forEach(function (k) { var v = S.veh[k]; veh[k] = { tripId: k, headsign: v.headsign, dirId: v.dirId, shapeId: v.shapeId, predicted: v.predicted, dev: v.dev, sObs: v.sObs, total: v.total, pos: v.pos, phase: v.phase, gpsAt: v.gpsAt }; if (S.trips[k]) keepTrips[k] = S.trips[k]; });
  if (S.arr) S.arr.list.forEach(function (x) { if (S.trips[x.tripId]) keepTrips[x.tripId] = S.trips[x.tripId]; });
  Object.keys(S.trips).forEach(function (k) { var tt = S.trips[k]; if (tt.next && keepTrips[k]) keepTrips[k] = tt; });
  store.set('snap', { at: Date.now(), veh: veh, trips: keepTrips, arr: S.arr, lastOk: S.lastOk });
}
function loadSnap() {
  var sn = store.get('snap', null);
  if (!sn || Date.now() - sn.at > 20 * 60000) return;
  S.trips = sn.trips || {};
  Object.keys(sn.veh || {}).forEach(function (k) { var v = sn.veh[k]; v.lastS = null; v.corr = 0; v.offset = 0; v.tObs = Date.now(); S.veh[k] = v; });
  S.arr = sn.arr; S.lastOk = sn.lastOk || 0;
}
async function refresh(manual) {
  if (S.busy) return;
  S.busy = true;
  try {
    var full = null;
    if (!S.line) full = await loadLine(false);
    if (S.line && (!S.from || stationIdx(S.from) < 0 || !S.to || stationIdx(S.to) < 0)) {
      renderSheet();
      if (!$('#picker').classList.contains('open')) openPicker(!S.from || stationIdx(S.from) < 0 ? 'from' : 'to', true);
    }
    if (map && mapReady) refreshOverlays();
    var r = full || await oba('trips-for-route/' + CFG.route + '.json', { includeStatus: 'true', includeSchedule: 'false' });
    ingest(r);
    var missing = Object.keys(S.veh).filter(function (k) { return !S.trips[k]; }).slice(0, 4);
    for (var i = 0; i < missing.length; i++) { try { await fetchTrip(missing[i]); } catch (e) { /* draw at GPS until it loads */ } }
    if (S.from && S.to) await loadArrivals();
    S.lastOk = now(); S.err = null;
    saveSnap();
    if (!refresh.framed && map && S.from && S.to) { refresh.framed = true; fitTrip(true); }
  } catch (e) {
    S.err = (e && e.message) || String(e);
    if (manual || !S.lastOk) toast(S.err);
    if (e && e.notFound) { store.del('line'); S.line = null; }
  } finally {
    S.busy = false;
    renderSheet();
    if (S.view === 'line') buildDiagram();
  }
}
var lastAuto = 0;
function kick() { lastAuto = Date.now(); refresh(true); }
setInterval(function () {
  tickTexts();
  if (document.visibilityState === 'hidden') return;
  if (Date.now() - lastAuto >= S.refreshSec * 1000) { lastAuto = Date.now(); refresh(false); }
}, 1000);
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') kick(); });

/* ================= wiring ================= */
function wire() {
  sheetBody.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'pick-from') openPicker('from');
    else if (act === 'pick-to') openPicker('to');
    else if (act === 'swap') { var t = S.from; S.from = S.to; S.to = t; store.set('from', S.from); store.set('to', S.to); tripChanged(); }
    else if (act === 'follow') {
      S.follow = !S.follow;
      if (S.follow && S.detent === 'full') setDetent('mid');
      if (S.follow && map) map.easeTo({ zoom: Math.max(map.getZoom(), 14), duration: 500 });
      renderSheet();
    }
    else if (act === 'close') { S.selected = null; S.follow = false; renderSheet(); }
  });
  $('#btnLine').addEventListener('click', function () { setView(S.view === 'line' ? 'map' : 'line'); });
  $('#btnLocate').addEventListener('click', function () { if (S.view === 'line') setView('map'); startLocate(true); });
  $('#btnSettings').addEventListener('click', function () {
    $('#keyInput').value = S.key === 'TEST' ? '' : S.key;
    document.querySelectorAll('#segRefresh button').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-v')) === S.refreshSec)); });
    $('#settings').classList.add('open');
  });
  $('#segRefresh').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.refreshSec = Number(b.getAttribute('data-v')); store.set('refreshSec', S.refreshSec);
    document.querySelectorAll('#segRefresh button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
  });
  $('#setDone').addEventListener('click', function () {
    var k = $('#keyInput').value.trim() || 'TEST';
    if (k !== S.key) { S.key = k; store.set('key', k); }
    $('#settings').classList.remove('open'); kick();
  });
  $('#resetData').addEventListener('click', function () {
    store.del('line'); store.del('snap'); S.line = null; S.trips = {};
    for (var k in S.veh) removeVehicleUI(S.veh[k]);
    S.veh = {}; S.arr = null;
    $('#settings').classList.remove('open'); kick();
  });
  $('#status').addEventListener('click', kick);
  $('#pickCancel').addEventListener('click', function () {
    if (pickFirstRun) {   // sensible defaults if skipped
      if (!S.from) S.from = 'Marymoor Village';
      if (!S.to) S.to = 'Lynnwood City Center';
      if (stationIdx(S.from) < 0 && S.line) S.from = S.line.stations[0].name;
      if (stationIdx(S.to) < 0 && S.line) S.to = S.line.stations[S.line.stations.length - 1].name;
      store.set('from', S.from); store.set('to', S.to); tripChanged();
    }
    closePicker();
  });
  $('#pickSearch').addEventListener('input', renderPicker);
  $('#pickList').addEventListener('click', function (e) {
    var n = e.target.closest('[data-near]');
    if (n) { if (S.me) pickNearest(); else startLocate('near'); return; }
    var b = e.target.closest('[data-st]'); if (b) choose(b.getAttribute('data-st'));
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePicker(); $('#settings').classList.remove('open'); } });
}

/* ================= start ================= */
(function start() {
  initSheet(); wire();
  var c = store.get('line', null);
  if (c && c.v === 3) finishLine(c);
  loadSnap();
  renderSheet();
  initMap();
  requestAnimationFrame(frame);
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(function (p) { if (p.state === 'granted') startLocate(false); }, function () {});
  } else if (store.get('locOk', false)) startLocate(false);
  if (S.line && (!S.from || !S.to)) openPicker(!S.from ? 'from' : 'to', true);
  lastAuto = Date.now(); refresh(false);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) { reg.update(); }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  }
})();
