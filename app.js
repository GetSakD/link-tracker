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
  me: null, meWatch: null, detent: 'mid',
  mode: store.get('mode', 'trains'), busStops: {}, busRoutes: {}, busSel: null, busArr: null, busFilter: 'all'
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
  ((refs && refs.routes) || []).forEach(function (r) { S.busRoutes[r.id] = r; });
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
  map.on('style.load', function () { tidyStyle(); addOverlays(); addBusLayers(); addPlanLayers(); mapReady = true; applyModeLayers(); applyPadding(); if (S.mode === 'buses') scheduleStopFetch(); });
  map.on('dragstart', function () { if (S.follow) { S.follow = false; renderSheet(); } });
  map.on('moveend', function () { if (S.mode === 'buses') scheduleStopFetch(); });
  map.on('click', 'lt-bus', function (e) { var f = e.features && e.features[0]; if (f) selectStop(f.properties.id); });
  map.on('mouseenter', 'lt-bus', function () { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'lt-bus', function () { map.getCanvas().style.cursor = ''; });
  map.on('click', function (e) {
    var tg = e.originalEvent && e.originalEvent.target;
    if (tg && tg.closest && tg.closest('.maplibregl-marker')) return;
    if (S.mode === 'buses') {
      if (map.getLayer('lt-bus') && map.queryRenderedFeatures(e.point, { layers: ['lt-bus'] }).length) return;
      if (S.busSel) { S.busSel = null; S.busArr = null; updateBusLayer(); updateBusMarkers(); renderSheet(); }
      return;
    }
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
  outer.className = 'train-mk';
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
  if (S.plan) { renderPlanSheet(); return; }
  if (S.mode === 'buses') { renderBusSheet(); return; }
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


/* ================= buses ================= */
var BUS_ZOOM = 14.5, CELL = 0.012, stopFetched = {}, stopTimer = null, busMarkers = {};
var BUSSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 3h12a3 3 0 0 1 3 3v10a2 2 0 0 1-1 1.7V20a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H7v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2.3A2 2 0 0 1 3 16V6a3 3 0 0 1 3-3zm0 3v5h12V6H6zm1 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm10 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>';
var DIRS_TXT = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest' };
function routeColor(r) { return r && r.color ? '#' + String(r.color).replace('#', '') : '#30B0C7'; }
function routeText(r) { return r && r.textColor ? '#' + String(r.textColor).replace('#', '') : '#FFFFFF'; }
function routeName(r) { return r ? (r.shortName || r.nullSafeShortName || r.longName || '') : ''; }
function rbHTML(r, sm) { return '<span class="rb' + (sm ? ' sm' : '') + '" style="background:' + esc(routeColor(r)) + ';color:' + esc(routeText(r)) + '">' + esc(routeName(r)) + '</span>'; }
function byRouteName(a, b) { return routeName(S.busRoutes[a]).localeCompare(routeName(S.busRoutes[b]), 'en', { numeric: true }); }
async function fetchStopsAt(lat, lon, radius) {
  var r = await oba('stops-for-location.json', { lat: lat.toFixed(5), lon: lon.toFixed(5), radius: Math.round(radius), maxCount: 250 });
  (r.list || []).forEach(function (s) {
    var rids = (s.routeIds || []).filter(function (id) { var rt = S.busRoutes[id]; return rt && Number(rt.type) === 3; });
    if (!rids.length) return;
    S.busStops[s.id] = { id: s.id, name: s.name, lat: s.lat, lon: s.lon, dir: s.direction || '', code: s.code || '', routes: rids.sort(byRouteName) };
  });
  updateBusLayer();
}
function scheduleStopFetch() {
  clearTimeout(stopTimer);
  stopTimer = setTimeout(async function () {
    if (!map || S.mode !== 'buses') return;
    var z = map.getZoom();
    $('#hint').classList.toggle('hidden', z >= BUS_ZOOM);
    if (z < BUS_ZOOM) return;
    var b = map.getBounds(), cells = [];
    for (var la = Math.floor(b.getSouth() / CELL); la <= Math.floor(b.getNorth() / CELL); la++)
      for (var lo = Math.floor(b.getWest() / CELL); lo <= Math.floor(b.getEast() / CELL); lo++) if (!stopFetched[la + ',' + lo]) cells.push([la, lo]);
    var c = map.getCenter();
    cells.sort(function (p, q) { return Math.hypot((p[0] + .5) * CELL - c.lat, (p[1] + .5) * CELL - c.lng) - Math.hypot((q[0] + .5) * CELL - c.lat, (q[1] + .5) * CELL - c.lng); });
    for (var i = 0; i < Math.min(cells.length, 10); i++) {
      var k = cells[i].join(','); stopFetched[k] = 1;
      try { await fetchStopsAt((cells[i][0] + .5) * CELL, (cells[i][1] + .5) * CELL, 900); }
      catch (e) { delete stopFetched[k]; toast(e.message); break; }
      if (S.mode !== 'buses') return;
    }
    if (!S.busSel) renderSheet();
  }, 400);
}
function busGeo() {
  return { type: 'FeatureCollection', features: Object.keys(S.busStops).map(function (id) {
    var s = S.busStops[id];
    return { type: 'Feature', properties: { id: id, name: s.name, sel: id === S.busSel ? 1 : 0 }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } };
  }) };
}
function busIcon() {
  var k = 2, w = 26 * k, c = document.createElement('canvas'); c.width = c.height = w;
  var g = c.getContext('2d');
  function rr(x, y, ww, hh, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + ww, y, x + ww, y + hh, r); g.arcTo(x + ww, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + ww, y, r); g.closePath(); }
  rr(1 * k, 1 * k, 24 * k, 24 * k, 7 * k); g.fillStyle = '#FFFFFF'; g.fill();
  rr(3 * k, 3 * k, 20 * k, 20 * k, 5.5 * k); g.fillStyle = '#30B0C7'; g.fill();
  g.fillStyle = '#FFFFFF'; rr(8 * k, 7 * k, 10 * k, 10.5 * k, 2.2 * k); g.fill();
  g.fillStyle = '#30B0C7'; g.fillRect(9.3 * k, 8.6 * k, 7.4 * k, 4 * k);
  g.fillStyle = '#FFFFFF'; g.fillRect(9 * k, 17.2 * k, 2 * k, 2.3 * k); g.fillRect(15 * k, 17.2 * k, 2 * k, 2.3 * k);
  return { width: w, height: w, data: new Uint8Array(g.getImageData(0, 0, w, w).data.buffer) };
}
function addBusLayers() {
  if (!map) return;
  var dark = isDark();
  if (!map.hasImage('lt-bus-ico')) map.addImage('lt-bus-ico', busIcon(), { pixelRatio: 2 });
  if (map.getSource('lt-bus')) map.getSource('lt-bus').setData(busGeo()); else map.addSource('lt-bus', { type: 'geojson', data: busGeo() });
  if (!map.getLayer('lt-bus-sel')) map.addLayer({ id: 'lt-bus-sel', type: 'circle', source: 'lt-bus', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 20, 'circle-color': '#30B0C7', 'circle-opacity': 0.25 } });
  if (!map.getLayer('lt-bus')) map.addLayer({ id: 'lt-bus', type: 'symbol', source: 'lt-bus', layout: {
    'icon-image': 'lt-bus-ico', 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.62, 17, 1, 18, 1.15], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
    'symbol-sort-key': ['get', 'sel'] } });
  if (!map.getLayer('lt-bus-label')) map.addLayer({ id: 'lt-bus-label', type: 'symbol', source: 'lt-bus', minzoom: 16.3, layout: {
    'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 1.3], 'text-optional': true, 'text-max-width': 9 },
    paint: { 'text-color': dark ? '#F2F2F7' : '#1C1C1E', 'text-halo-color': dark ? '#000' : '#fff', 'text-halo-width': 1.5 } });
}
function updateBusLayer() { if (map && mapReady && map.getSource('lt-bus')) map.getSource('lt-bus').setData(busGeo()); }
function applyModeLayers() {
  if (!map || !mapReady) return;
  var bus = S.mode === 'buses';
  ['lt-route-case', 'lt-route', 'lt-trip', 'lt-st', 'lt-st-label', 'lt-st-label-end'].forEach(function (id) { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', bus ? 'none' : 'visible'); });
  ['lt-bus', 'lt-bus-label', 'lt-bus-sel'].forEach(function (id) { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', bus ? 'visible' : 'none'); });
}
function setMode(m) {
  if (m === S.mode) return;
  S.mode = m; store.set('mode', m);
  document.body.classList.toggle('mode-bus', m === 'buses');
  document.querySelectorAll('.modeseg button').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-mode') === m)); });
  if (m === 'buses' && S.view === 'line') setView('map');
  S.selected = null; S.follow = false;
  applyModeLayers();
  if (m === 'buses') {
    if (map && map.getZoom() < BUS_ZOOM) map.easeTo({ center: S.me ? [S.me.lon, S.me.lat] : map.getCenter(), zoom: 15.5, duration: 700 });
    else scheduleStopFetch();
    if (S.me) fetchStopsAt(S.me.lat, S.me.lon, 700).then(renderSheet, function () {});
  } else {
    $('#hint').classList.add('hidden');
    if (map && S.from && S.to) fitTrip(true);
  }
  updateBusMarkers();
  renderSheet(); kick();
}
function selectStop(id) {
  if (!S.busStops[id]) return;
  S.busSel = id; S.busArr = null; S.busFilter = 'all';
  updateBusLayer();
  if (S.detent === 'peek') setDetent('mid');
  renderSheet();
  var s = S.busStops[id];
  if (map) map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 600 });
  loadStopArrivals().then(renderSheet, function (e) { toast(e.message); });
}
async function loadStopArrivals() {
  var id = S.busSel; if (!id) return;
  var r = await oba('arrivals-and-departures-for-stop/' + encodeURIComponent(id) + '.json', { minutesBefore: 1, minutesAfter: 90 });
  var t = now();
  var list = ((r.entry && r.entry.arrivalsAndDepartures) || []).filter(function (x) { return x.departureEnabled !== false; }).map(function (x) {
    var live = x.predicted === true && ((x.predictedDepartureTime || 0) > 0 || (x.predictedArrivalTime || 0) > 0);
    var sched = x.scheduledDepartureTime || x.scheduledArrivalTime, pred = live ? (x.predictedDepartureTime || x.predictedArrivalTime) : 0;
    var ts = x.tripStatus || {};
    return { tripId: x.tripId, routeId: x.routeId, headsign: x.tripHeadsign, t: pred || sched, sched: sched, live: live, dev: live ? Math.round((pred - sched) / 1000) : 0,
      stopsAway: typeof x.numberOfStopsAway === 'number' ? x.numberOfStopsAway : null,
      pos: live && ts.position ? { lat: ts.position.lat, lon: ts.position.lon } : null, canceled: /cancel/i.test(String(ts.status || '')) };
  }).filter(function (x) { return x.t >= t - 60000; }).sort(function (p, q) { return p.t - q.t; }).slice(0, 30);
  if (id !== S.busSel) return;
  S.busArr = { id: id, at: t, list: list };
  updateBusMarkers();
}
function tweenMarker(m, to) {
  var from = m.getLngLat(), t0 = null;
  function step(t) {
    if (t0 === null) t0 = t;
    var k = Math.min(1, (t - t0) / 1500); k = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    m.setLngLat([from.lng + (to.lon - from.lng) * k, from.lat + (to.lat - from.lat) * k]);
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function updateBusMarkers() {
  if (!map) return;
  var keep = {}, shown = 0, list = (S.mode === 'buses' && S.busArr && S.busArr.id === S.busSel) ? S.busArr.list : [];
  list.forEach(function (x) {
    if (!x.pos || x.canceled || shown >= 10 || keep[x.tripId]) return;
    if (S.busFilter !== 'all' && x.routeId !== S.busFilter) return;
    shown++; keep[x.tripId] = 1;
    var r = S.busRoutes[x.routeId], m = busMarkers[x.tripId];
    if (!m) {
      var el = document.createElement('div');
      el.className = 'busmk'; el.style.background = routeColor(r); el.style.color = routeText(r); el.textContent = routeName(r);
      el.setAttribute('aria-label', 'Route ' + routeName(r) + ' bus to ' + (x.headsign || ''));
      m = busMarkers[x.tripId] = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([x.pos.lon, x.pos.lat]).addTo(map);
    } else tweenMarker(m, x.pos);
  });
  Object.keys(busMarkers).forEach(function (k) { if (!keep[k]) { busMarkers[k].remove(); delete busMarkers[k]; } });
}
function renderBusSheet() {
  var html = '';
  var s = S.busSel && S.busStops[S.busSel];
  if (s) {
    var meta = [DIRS_TXT[s.dir] || '', s.code ? 'Stop ' + s.code : '', S.me ? miles(dist(s, S.me)) + ' away' : ''].filter(Boolean).join(' · ');
    html += '<div class="drag-zone"><div class="d-head"><div class="stop-ico" style="width:42px;height:42px;border-radius:12px">' + BUSSVG + '</div><div class="d-title"><h2>' + esc(s.name) + '</h2><div>' + esc(meta) + '</div></div>' +
      '<button class="close" type="button" data-act="bus-close" aria-label="Close"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div></div>';
    if (!S.busArr || S.busArr.id !== s.id) {
      html += '<div class="skel" style="height:58px;margin-top:16px"></div><div class="skel" style="height:58px;margin-top:8px"></div><div class="skel" style="height:58px;margin-top:8px"></div>';
    } else {
      var here = {};
      S.busArr.list.forEach(function (x) { here[x.routeId] = 1; });
      var ids = Object.keys(here).sort(byRouteName);
      if (S.busFilter !== 'all' && !here[S.busFilter]) S.busFilter = 'all';
      if (ids.length > 1) html += '<div class="chips"><button type="button" data-route="all" aria-pressed="' + (S.busFilter === 'all') + '">All</button>' +
        ids.map(function (id) { return '<button type="button" data-route="' + esc(id) + '" aria-pressed="' + (S.busFilter === id) + '">' + esc(routeName(S.busRoutes[id])) + '</button>'; }).join('') + '</div>';
      var list = S.busArr.list.filter(function (x) { return S.busFilter === 'all' || x.routeId === S.busFilter; }).slice(0, 15);
      html += '<div class="sec">Next buses</div><div class="group">';
      if (!list.length) html += '<div class="empty">No buses from this stop in the next 90 minutes.</div>';
      list.forEach(function (x) {
        html += '<div class="bdep' + (x.canceled ? ' canceled' : '') + '">' + rbHTML(S.busRoutes[x.routeId]) +
          '<div class="m"><div class="h">' + esc(x.headsign || '') + '</div><div class="s">' + chip(x.dev, x.live, x.canceled) +
          (x.live && x.stopsAway > 0 ? ' ' + x.stopsAway + (x.stopsAway === 1 ? ' stop away' : ' stops away') : '') + '</div></div>' +
          '<div class="mins num">' + (x.canceled ? '–' : cdHTML(x.t)) + '<div>' + clock(x.t) + '</div></div></div>';
      });
      html += '</div>';
    }
    html += '<p class="foot">Buses heading to this stop are shown on the map. Live data from King County Metro, Community Transit and Sound Transit.</p>';
  } else {
    html += '<div class="drag-zone"><div class="hero-title" style="font-size:20px;font-weight:700;white-space:normal">Bus stops</div><div class="hero-sub">Tap any bus stop on the map to see its next buses.</div></div>' +
      '<div class="group" style="margin-top:12px"><button class="cell" type="button" data-act="dirs"><span class="loc-ico" style="background:var(--fill);color:var(--label2)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg></span><span class="v" style="color:var(--label2)">Where to?</span></button></div>';
    if (S.me) {
      var near = Object.keys(S.busStops).map(function (id) { var q = S.busStops[id]; return { s: q, d: dist(q, S.me) }; }).sort(function (p, q) { return p.d - q.d; }).slice(0, 8);
      if (near.length) {
        html += '<div class="sec">Nearby</div><div class="group">' + near.map(function (o) {
          return '<button class="cell ind-40" type="button" data-stop="' + esc(o.s.id) + '"><span class="stop-ico">' + BUSSVG + '</span><span class="v" style="white-space:normal">' + esc(o.s.name) +
            '<span class="rbs">' + o.s.routes.slice(0, 8).map(function (id) { return rbHTML(S.busRoutes[id], true); }).join('') + '</span></span><span class="r num">' + miles(o.d) + '</span></button>';
        }).join('') + '</div>';
      } else html += '<div class="empty">Finding stops near you…</div>';
    } else {
      html += '<div class="sec">&nbsp;</div><div class="group"><button class="cell" type="button" data-act="bus-locate"><span class="loc-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.6 3.4a.9.9 0 0 0-1-.2L3.7 10.1a.9.9 0 0 0 .1 1.7l6.6 1.8 1.8 6.6a.9.9 0 0 0 1.7.1l6.9-15.9a.9.9 0 0 0-.2-1z"/></svg></span><span class="v" style="color:var(--blue)">Show stops near me</span></button></div>';
    }
  }
  sheetBody.innerHTML = html;
  tickTexts();
}


/* ================= directions (Transitous trip planner) ================= */
var PLAN_API = window.PLAN_API || 'https://api.transitous.org/api/v1/';
var D = { from: null, to: null, field: 'to', mode: null, timer: null, results: [] };
var WALKSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="M14.5 7.5l-3 .2-3 3.3.9 1 2.3-1.8.6 3.4-2.8 4.4 1.3.9 3.1-4.2 1.4 1.6V21h1.6v-6.3l-1.9-2.3.4-2.6 1.4 1.6H19v-1.6h-2.1z"/></svg>';
function decodePoly(str, prec) {
  var f = Math.pow(10, prec || 7), i = 0, lat = 0, lon = 0, out = [];
  function next() { var res = 0, mul = 1, b; do { b = str.charCodeAt(i++) - 63; res += (b & 0x1f) * mul; mul *= 32; } while (b >= 0x20 && i < str.length); return (res % 2) ? -(res + 1) / 2 : res / 2; }
  while (str && i < str.length) { lat += next(); lon += next(); out.push([lon / f, lat / f]); }
  return out;
}
function openDirs() {
  D.mode = D.mode || (S.mode === 'buses' ? 'bus' : 'all');
  D.field = D.to ? 'to' : 'to';
  setDirTexts();
  $('#dirSearch').value = '';
  renderDirResults([]);
  $('#dirs').classList.add('open');
  setTimeout(function () { try { $('#dirSearch').focus(); } catch (e) {} }, 350);
}
function closeDirs() { $('#dirs').classList.remove('open'); }
function setDirTexts() {
  $('#dirFromTxt').textContent = D.from ? D.from.name : 'My Location';
  $('#dirToTxt').textContent = D.to ? D.to.name : 'Choose destination';
  $('#dirToTxt').style.color = D.to ? '' : 'var(--label2)';
  $('#dirSearchLabel').textContent = D.field === 'from' ? 'Search starting point' : 'Search destination';
  $('#dirSearch').placeholder = D.field === 'from' ? 'Where are you starting?' : 'Address, place or stop';
  document.querySelectorAll('#dirModes button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-m') === D.mode)); });
}
function renderDirResults(list) {
  D.results = list;
  var html = '';
  if (D.field === 'from') html += '<div class="sec">&nbsp;</div><div class="group"><button class="cell" type="button" data-cur="1"><span class="loc-ico">' + '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.6 3.4a.9.9 0 0 0-1-.2L3.7 10.1a.9.9 0 0 0 .1 1.7l6.6 1.8 1.8 6.6a.9.9 0 0 0 1.7.1l6.9-15.9a.9.9 0 0 0-.2-1z"/></svg></span><span class="v" style="color:var(--blue)">My Location</span></button></div>';
  if (list.length) {
    html += '<div class="sec">Results</div><div class="group">' + list.map(function (x, i) {
      var sub = [x.street ? (x.houseNumber ? x.houseNumber + ' ' : '') + x.street : '', ((x.areas || []).filter(function (ar) { return !/United States|Washington/.test(ar.name); })[0] || {}).name].filter(Boolean).join(', ');
      var ico = x.type === 'STOP' ? '<span class="stop-ico">' + BUSSVG + '</span>' : '<span class="loc-ico" style="background:var(--red)"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg></span>';
      return '<button class="cell ind-40" type="button" data-gi="' + i + '">' + ico + '<span class="v" style="white-space:normal">' + esc(x.name) + (sub ? '<span style="display:block;font-size:13px;color:var(--label2)">' + esc(sub) + '</span>' : '') + '</span>' +
        (S.me ? '<span class="r num">' + miles(dist(x, S.me)) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  } else if ($('#dirSearch').value.trim().length >= 2) html += '<div class="empty">Searching…</div>';
  $('#dirResults').innerHTML = html;
}
async function geocode(q) {
  var c = S.me || (map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : CFG.north);
  var r = await fetch(PLAN_API + 'geocode?text=' + encodeURIComponent(q) + '&place=' + c.lat.toFixed(4) + ',' + c.lon.toFixed(4));
  if (!r.ok) throw new Error('Search isn\'t available right now.');
  var j = await r.json();
  return (j || []).filter(function (x) { return x && x.lat != null; }).slice(0, 12);
}
function chooseDir(x) {
  var p = { name: x.name, lat: x.lat, lon: x.lon };
  if (D.field === 'from') { D.from = p; D.field = 'to'; } else D.to = p;
  $('#dirSearch').value = ''; renderDirResults([]); setDirTexts();
  if (D.to && (D.from || S.me)) runPlan();
}
function legMin(l) { return Math.max(1, Math.round((Date.parse(l.endTime) - Date.parse(l.startTime)) / 60000)); }
function legColor(l) { return l.routeColor ? '#' + String(l.routeColor).replace('#', '') : (l.mode === 'WALK' ? '#8E8E93' : '#30B0C7'); }
function legText(l) { return l.routeTextColor ? '#' + String(l.routeTextColor).replace('#', '') : '#FFFFFF'; }
function legBadge(l, sm) { return '<span class="rb' + (sm ? ' sm' : '') + '" style="background:' + esc(legColor(l)) + ';color:' + esc(legText(l)) + '">' + esc(l.routeShortName || l.displayName || l.mode) + '</span>'; }
function placeName(p, end) { return !p || p.name === 'START' ? (D.from ? D.from.name : 'your location') : p.name === 'END' ? (D.to ? D.to.name : 'your destination') : p.name; }
async function runPlan() {
  var from = D.from || S.me;
  if (!from) { startLocate(false); toast('Turn on location, or choose a starting point.'); D.field = 'from'; setDirTexts(); renderDirResults([]); return; }
  if (!D.to) { toast('Choose where you want to go.'); return; }
  closeDirs();
  S.selected = null; S.follow = false;
  S.plan = { loading: true, mode: D.mode, from: D.from ? D.from.name : 'My Location', to: D.to.name };
  setDetent('mid'); renderSheet();
  var url = PLAN_API + 'plan?fromPlace=' + from.lat.toFixed(6) + ',' + from.lon.toFixed(6) + '&toPlace=' + D.to.lat.toFixed(6) + ',' + D.to.lon.toFixed(6) +
    '&time=' + encodeURIComponent(new Date(now()).toISOString()) + (D.mode === 'bus' ? '&transitModes=BUS' : '');
  try {
    var r = await fetch(url);
    if (!r.ok) throw new Error('The trip planner isn\'t available right now (' + r.status + ').');
    var j = await r.json(), seen = {};
    var its = (j.itineraries || []).filter(function (it) {
      var k = it.legs.map(function (l) { return (l.routeShortName || l.mode) + '@' + l.startTime; }).join('|');
      if (seen[k]) return false; seen[k] = 1;
      return Date.parse(it.endTime) > now();
    }).sort(function (p, q) { return Date.parse(p.endTime) - Date.parse(q.endTime); }).slice(0, 6);
    S.plan = { mode: D.mode, from: S.plan.from, to: S.plan.to, its: its, sel: its.length ? 0 : null };
  } catch (e) {
    S.plan = { mode: D.mode, from: S.plan.from, to: S.plan.to, err: e.message || 'The trip planner isn\'t available right now.', its: [] };
  }
  drawPlan(); renderSheet();
}
function planGeo() {
  var fc = { type: 'FeatureCollection', features: [] }, pts = { type: 'FeatureCollection', features: [] };
  var it = S.plan && S.plan.its && S.plan.its[S.plan.sel];
  if (!it) return { lines: fc, pts: pts };
  it.legs.forEach(function (l) {
    var g = l.legGeometry ? decodePoly(l.legGeometry.points, l.legGeometry.precision) : [];
    if (g.length > 1) fc.features.push({ type: 'Feature', properties: { walk: l.mode === 'WALK' ? 1 : 0, color: legColor(l) }, geometry: { type: 'LineString', coordinates: g } });
    if (l.mode !== 'WALK') [l.from, l.to].forEach(function (p) { if (p) pts.features.push({ type: 'Feature', properties: { color: legColor(l) }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }); });
  });
  var last = it.legs[it.legs.length - 1].to;
  if (last) pts.features.push({ type: 'Feature', properties: { color: '#FF3B30', end: 1 }, geometry: { type: 'Point', coordinates: [last.lon, last.lat] } });
  return { lines: fc, pts: pts };
}
function addPlanLayers() {
  if (!map) return;
  var g = planGeo();
  if (map.getSource('lt-plan')) { map.getSource('lt-plan').setData(g.lines); map.getSource('lt-plan-pts').setData(g.pts); return; }
  map.addSource('lt-plan', { type: 'geojson', data: g.lines });
  map.addSource('lt-plan-pts', { type: 'geojson', data: g.pts });
  var halo = isDark() ? '#000000' : '#FFFFFF';
  map.addLayer({ id: 'lt-plan-case', type: 'line', source: 'lt-plan', filter: ['==', ['get', 'walk'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': halo, 'line-width': 10 } });
  map.addLayer({ id: 'lt-plan-line', type: 'line', source: 'lt-plan', filter: ['==', ['get', 'walk'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 6 } });
  map.addLayer({ id: 'lt-plan-walk', type: 'line', source: 'lt-plan', filter: ['==', ['get', 'walk'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0A84FF', 'line-width': 5, 'line-dasharray': [0.1, 1.8] } });
  map.addLayer({ id: 'lt-plan-pts', type: 'circle', source: 'lt-plan-pts', paint: { 'circle-radius': ['case', ['==', ['get', 'end'], 1], 8, 6], 'circle-color': ['case', ['==', ['get', 'end'], 1], '#FF3B30', halo], 'circle-stroke-color': ['case', ['==', ['get', 'end'], 1], halo, ['get', 'color']], 'circle-stroke-width': 3 } });
}
function drawPlan() {
  if (!map || !mapReady) return;
  addPlanLayers();
  var g = planGeo(), coords = [];
  g.lines.features.forEach(function (f) { coords = coords.concat(f.geometry.coordinates); });
  if (!coords.length) return;
  var xs = coords.map(function (c) { return c[0]; }), ys = coords.map(function (c) { return c[1]; });
  map.fitBounds([[Math.min.apply(null, xs), Math.min.apply(null, ys)], [Math.max.apply(null, xs), Math.max.apply(null, ys)]],
    { padding: { top: topInset() + 30, bottom: sheetVisible() + 30, left: 40, right: 70 }, maxZoom: 16, duration: 800 });
}
function clearPlan() { S.plan = null; if (map && map.getSource('lt-plan')) { addPlanLayers(); } renderSheet(); }
function itLegs(it) {
  return it.legs.map(function (l) {
    if (l.mode === 'WALK') return legMin(l) < 2 && it.legs.length > 1 ? '' : '<span class="wk">' + WALKSVG + legMin(l) + '</span>';
    return legBadge(l, true);
  }).filter(Boolean).join('<span aria-hidden="true">›</span>');
}
function renderPlanSheet() {
  var P = S.plan, html = '';
  html += '<div class="drag-zone"><div class="d-head"><div class="d-badge" style="background:var(--blue)"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/></svg></div>' +
    '<div class="d-title"><h2>To ' + esc(P.to) + '</h2><div>From ' + esc(P.from) + ' · ' + (P.mode === 'bus' ? 'Bus only' : 'Bus & train') + '</div></div>' +
    '<button class="close" type="button" data-act="plan-close" aria-label="Close directions"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div></div>';
  if (P.loading) html += '<div class="skel" style="height:84px;margin-top:16px"></div><div class="skel" style="height:84px;margin-top:8px"></div>';
  else if (P.err) html += '<div class="empty">' + esc(P.err) + '</div>';
  else if (!P.its.length) html += '<div class="empty">No trips found right now.' + (P.mode === 'bus' ? ' Try “Bus & train”.' : '') + '</div><div class="group"><button class="cell" type="button" data-act="plan-edit"><span class="v" style="color:var(--blue)">Change trip</span></button></div>';
  else {
    html += '<div class="sec"><span>Routes</span><button type="button" data-act="plan-edit" style="color:var(--blue);text-transform:none;font-size:15px">Edit</button></div><div class="group">';
    P.its.forEach(function (it, i) {
      var first = it.legs.filter(function (l) { return l.mode !== 'WALK'; })[0];
      html += '<button class="it' + (i === P.sel ? ' on' : '') + '" type="button" data-it="' + i + '"><div class="row1"><span class="dur num">' + Math.round(it.duration / 60) + ' min</span>' +
        '<span class="tt num">' + clock(Date.parse(it.startTime)) + ' – ' + clock(Date.parse(it.endTime)) + '</span></div><div class="legs">' + itLegs(it) + '</div>' +
        '<div class="sub">' + (first ? 'Board ' + esc(first.routeShortName || 'at') + ' at ' + esc(first.from.name) + ' · ' + clock(Date.parse(first.startTime)) : 'Walk the whole way') +
        (it.transfers ? ' · ' + it.transfers + (it.transfers === 1 ? ' transfer' : ' transfers') : '') + '</div></button>';
    });
    html += '</div>';
    var it = P.its[P.sel];
    if (it) {
      html += '<div class="sec">Steps</div><div class="group">';
      it.legs.forEach(function (l) {
        if (l.mode === 'WALK') {
          if (legMin(l) < 2 && it.legs.length > 1) return;
          html += '<div class="step"><div class="ic"><span class="walk-ico">' + WALKSVG + '</span></div><div class="tx">Walk to ' + esc(placeName(l.to)) + '<small>' + legMin(l) + ' min</small></div><div class="tm num">' + clock(Date.parse(l.startTime)) + '</div></div>';
        } else {
          var n = (l.intermediateStops || []).length + 1;
          html += '<div class="step"><div class="ic">' + legBadge(l, true) + '</div><div class="tx">Take ' + esc(l.routeShortName || l.displayName || 'the ' + l.mode.toLowerCase()) + (l.headsign ? ' toward ' + esc(l.headsign) : '') +
            '<small>Board at ' + esc(l.from.name) + ' · ride ' + n + (n === 1 ? ' stop' : ' stops') + ' (' + legMin(l) + ' min)<br>Get off at ' + esc(l.to.name) + ' · ' + clock(Date.parse(l.endTime)) + '</small></div>' +
            '<div class="tm num">' + clock(Date.parse(l.startTime)) + '</div></div>';
        }
      });
      html += '<div class="step"><div class="ic"><span class="walk-ico" style="background:var(--red);color:#fff">●</span></div><div class="tx">Arrive at ' + esc(P.to) + '</div><div class="tm num">' + clock(Date.parse(it.endTime)) + '</div></div></div>';
    }
    html += '<p class="foot">Routes are planned with the official timetables by Transitous, a free open trip planner. Times can shift with traffic, so check live bus times in Buses mode before you leave.</p>';
  }
  sheetBody.innerHTML = html;
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
      if (first && fly && map) map.easeTo({ center: [S.me.lon, S.me.lat], zoom: Math.max(map.getZoom(), S.mode === 'buses' ? 15.5 : 14), duration: 800 });
      if (first && S.mode === 'buses') { fetchStopsAt(S.me.lat, S.me.lon, 700).then(renderSheet, function () {}); }
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
    if (S.mode === 'buses') {
      if (S.busSel) await loadStopArrivals();
      S.lastOk = now(); S.err = null;
      return;
    }
    var full = null;
    if (!S.line) full = await loadLine(false);
    if (S.mode === 'trains' && S.line && (!S.from || stationIdx(S.from) < 0 || !S.to || stationIdx(S.to) < 0)) {
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
    var itb = e.target.closest('[data-it]'); if (itb && S.plan) { S.plan.sel = Number(itb.getAttribute('data-it')); drawPlan(); renderSheet(); return; }
    var st = e.target.closest('[data-stop]'); if (st) { selectStop(st.getAttribute('data-stop')); return; }
    var rt = e.target.closest('[data-route]'); if (rt) { S.busFilter = rt.getAttribute('data-route'); renderSheet(); updateBusMarkers(); return; }
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
    else if (act === 'bus-close') { S.busSel = null; S.busArr = null; updateBusLayer(); updateBusMarkers(); renderSheet(); }
    else if (act === 'bus-locate') startLocate(true);
    else if (act === 'plan-close') clearPlan();
    else if (act === 'plan-edit') openDirs();
    else if (act === 'dirs') openDirs();
  });
  document.querySelectorAll('.modeseg button').forEach(function (b) { b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); }); });
  $('#btnDir').addEventListener('click', openDirs);
  $('#dirCancel').addEventListener('click', closeDirs);
  $('#dirGo').addEventListener('click', runPlan);
  $('#dirFromBtn').addEventListener('click', function () { D.field = 'from'; setDirTexts(); renderDirResults([]); $('#dirSearch').focus(); });
  $('#dirToBtn').addEventListener('click', function () { D.field = 'to'; setDirTexts(); renderDirResults([]); $('#dirSearch').focus(); });
  $('#dirModes').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; D.mode = b.getAttribute('data-m'); setDirTexts(); });
  $('#dirSearch').addEventListener('input', function () {
    clearTimeout(D.timer);
    var q = this.value.trim();
    if (q.length < 2) { renderDirResults([]); return; }
    renderDirResults([]);
    D.timer = setTimeout(function () { geocode(q).then(function (list) { if ($('#dirSearch').value.trim() === q) renderDirResults(list); }, function (e) { toast(e.message); }); }, 300);
  });
  $('#dirResults').addEventListener('click', function (e) {
    if (e.target.closest('[data-cur]')) { D.from = null; D.field = 'to'; setDirTexts(); renderDirResults([]); if (!S.me) startLocate(false); return; }
    var b = e.target.closest('[data-gi]'); if (b) chooseDir(D.results[Number(b.getAttribute('data-gi'))]);
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
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePicker(); closeDirs(); $('#settings').classList.remove('open'); } });
}

/* ================= start ================= */
(function start() {
  initSheet(); wire();
  document.body.classList.toggle('mode-bus', S.mode === 'buses');
  document.querySelectorAll('.modeseg button').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-mode') === S.mode)); });
  var c = store.get('line', null);
  if (c && c.v === 3) finishLine(c);
  loadSnap();
  renderSheet();
  initMap();
  requestAnimationFrame(frame);
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(function (p) { if (p.state === 'granted') startLocate(false); }, function () {});
  } else if (store.get('locOk', false)) startLocate(false);
  if (S.mode === 'trains' && S.line && (!S.from || !S.to)) openPicker(!S.from ? 'from' : 'to', true);
  lastAuto = Date.now(); refresh(false);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    var hadController = !!navigator.serviceWorker.controller, reloaded = false;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) { reg.update(); }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  }
})();
