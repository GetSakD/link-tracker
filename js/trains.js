/* Live trains on every line, and departures from your station. */
import { S, now } from './state.js';
import { oba, indexRefs, departures, passedStop } from './api.js';
import { stationIdx, stationOfStop, shape, mainShape, ensureShape, shapeFailed, cacheTimetable, isUp, tripUp, lineOf, tripLines, rideTo } from './line.js';
import { Follower } from './motion.js';
import { clamp, project, pointAt, headingAt, store } from './util.js';

/* ---------- where a train is ---------- */

// distance along the trip at timetable time tau, easing in and out of each station
function scheduleS(tt, tau) {
  const st = tt.st, n = st.length;
  if (tau <= st[0].d) return st[0].s;
  for (let k = 1; k < n; k++) {
    if (tau < st[k].a) {
      const dep = st[k - 1].d;
      let f = clamp((tau - dep) / Math.max(1, st[k].a - dep), 0, 1);
      f = f * f * (3 - 2 * f);
      return st[k - 1].s + (st[k].s - st[k - 1].s) * f;
    }
    if (tau <= st[k].d) return st[k].s;
  }
  return st[n - 1].s;
}
const modelS = (v, t) => { const tt = S.trips[v.tripId]; return tt ? scheduleS(tt, (t - tt.sd) / 1000 - v.dev) : null; };

// the line a train or trip belongs to
const lineFor = (route) => lineOf(route) || S.line;
// is this stop at that station, on that line?
const atStation = (stopId, name, L) => { const i = stationIdx(name, L); return i >= 0 && stationOfStop(stopId, L) === i; };

export function trainShape(v) {
  const L = lineFor(v.route); if (!L) return null;
  const id = S.trips[v.tripId]?.shapeId || v.shapeId;
  const sh = id && shape(id);
  if (sh) return sh;
  // wait for this trip's own track rather than placing the train on a stand-in (it can sit ~1 km off)
  if (id && !shapeFailed(id)) { ensureShape(id); return null; }
  return shape(v.dirId === L.dirDown && L.shapeDown ? L.shapeDown : L.shapeUp);
}

/* Anchor the timetable model to the train's real GPS fix: where it was when the fix was taken,
   moving on the timetable since. */
function anchor(v, t) {
  v.offset = 0;
  const tt = S.trips[v.tripId], sh = trainShape(v), m = modelS(v, t);
  if (m == null) return;
  if (v.gps && sh) {
    const pr = project(sh, v.gps), total = v.total || tt.st.at(-1).s || sh.len;
    if (pr.d < 150) {
      const at = v.gpsAt && v.gpsAt < t && t - v.gpsAt < 180000 ? v.gpsAt : t;
      v.offset = clamp(pr.s * (total / sh.len) - modelS(v, at), -3000, 3000);
    }
  } else if (v.predicted && v.sObs != null && Math.abs(v.sObs - m) > 250) v.offset = clamp(v.sObs - m, -3000, 3000);
}

// a position from GPS older than this is an estimate, and is drawn and labelled as one
export const GPS_FRESH_MS = 3 * 60000;
export const gpsFresh = v => !!(v && v.predicted && v.gps && (!v.gpsAt || now() - v.gpsAt < GPS_FRESH_MS));

/* Called every frame: moves the train's Follower and returns its point + heading. */
export function placeTrain(v, t, dt) {
  const sh = trainShape(v); if (!sh) return null;
  const tt = S.trips[v.tripId];
  let target, speed = 0;
  if (tt) {
    const total = v.total || tt.st.at(-1).s || sh.len, k = sh.len / (total || sh.len);
    const m = modelS(v, t), m2 = modelS(v, t + 1000);
    target = (m + v.offset) * k; speed = Math.max(0, (m2 - m) * k);
  } else target = project(sh, v.gps || v.pos).s;
  if (v.f.shape !== sh) { v.f.reset(target, speed); v.f.shape = sh; }
  const s = clamp(v.f.step(target, speed, dt), 0, sh.len);
  const p = pointAt(sh, s);
  p.heading = v.f.turn(headingAt(sh, s), dt, 300);
  return p;
}

/* ---------- the live feed ---------- */

export function ingest(r, route, seen = {}) {
  const refs = indexRefs(r.references), t = now();
  for (const e of r.list || []) {
    const tr0 = refs.trips[e.tripId];
    if (e.schedule && tr0?.routeId === route && !S.trips[e.tripId]) cacheTimetable(e.tripId, e.schedule, e.serviceDate, tr0);
    const st = e.status; if (!st) continue;
    if (st.activeTripId && st.activeTripId !== e.tripId) continue;   // describes another trip; that trip's entry shows it
    if (!st.predicted && !st.vehicleId) continue;                    // timetable-only ghost: no train is reporting
    const trip = refs.trips[e.tripId];
    if (!trip || trip.routeId !== route) continue;                   // a train can run other lines' trips too
    if (seen[e.tripId] || /deadhead/i.test(st.phase || '') || /cancel/i.test(st.status || '')) continue;
    const gps = st.predicted && st.lastKnownLocation?.lat ? st.lastKnownLocation : null;
    const pos = gps || st.position; if (!pos) continue;
    seen[e.tripId] = 1;
    const v = S.trains[e.tripId] || (S.trains[e.tripId] = { tripId: e.tripId, f: new Follower({ backTolerance: 150 }), offset: 0 });
    Object.assign(v, {
      route, headsign: trip.tripHeadsign || '', dirId: String(trip.directionId), shapeId: trip.shapeId,
      predicted: !!st.predicted, dev: st.scheduleDeviation || 0, sObs: st.distanceAlongTrip, total: st.totalDistanceAlongTrip,
      pos: { lat: pos.lat, lon: pos.lon }, gps: gps ? { lat: gps.lat, lon: gps.lon } : null,
      gpsAt: st.lastLocationUpdateTime || st.lastUpdateTime || 0, vehicleId: st.vehicleId || ''
    });
    anchor(v, t);
  }
  return seen;
}

const pendingTrips = {};
export async function fetchTrip(tripId) {
  if (!tripId || S.trips[tripId] || pendingTrips[tripId]) return;
  pendingTrips[tripId] = 1;
  try {
    const r = await oba('trip-details/' + encodeURIComponent(tripId), { includeSchedule: 'true', includeTrip: 'true', includeStatus: 'false' });
    cacheTimetable(tripId, r.entry?.schedule, r.entry?.serviceDate, indexRefs(r.references).trips[tripId]);
    if (S.trains[tripId]) anchor(S.trains[tripId], now());
  } finally { delete pendingTrips[tripId]; }
}

/* Every line's trains. A line whose request fails keeps the trains it had; the others still update. */
export async function refreshTrains(prefetched = {}) {
  const seen = {}, done = new Set();
  let lastErr = null;
  for (const route of S.lineOrder) {
    try {
      ingest(prefetched[route] || await oba('trips-for-route/' + route, { includeStatus: 'true', includeSchedule: 'false' }), route, seen);
      done.add(route);
    } catch (e) { lastErr = e; }
  }
  if (!done.size && lastErr) throw lastErr;
  for (const k in S.trains) if (!seen[k] && (done.has(S.trains[k].route) || !S.trains[k].route)) delete S.trains[k];
  const need = [...new Set(Object.values(S.trains).map(v => S.trips[v.tripId]?.shapeId || v.shapeId).filter(id => id && !shape(id) && !shapeFailed(id)))];
  if (need.length) { await Promise.all(need.map(ensureShape)); for (const k in S.trains) anchor(S.trains[k], now()); }
  for (const id of Object.keys(S.trains).filter(k => !S.trips[k]).slice(0, 4)) { try { await fetchTrip(id); } catch { /* drawn at GPS until it loads */ } }
}

/* ---------- departures from your station ---------- */

export const tripKey = () => S.from + '>' + rideTo();

export async function loadDepartures(onMore) {
  const routes = tripLines();
  if (!routes.length) return;
  // each line that serves your trip: which platform, and which direction counts
  const byStop = new Map();
  for (const route of routes) {
    const L = S.lines[route], a = stationIdx(S.from, L), b = stationIdx(rideTo(), L), up = b > a, st = L.stations[a];
    const stopId = up ? (st.up || st.down) : (st.down || st.up);
    if (!byStop.has(stopId)) byStop.set(stopId, []);
    byStop.get(stopId).push({ route, want: up ? L.dirUp : L.dirDown });
  }
  const t = now();
  let list = [], situations = [];
  for (const [stopId, wants] of byStop) {
    const { refs, rows } = await departures(stopId, 120);
    situations.push(...refs.situations);
    list.push(...rows.filter(x => x.departs && x.t >= t - HARD_CUTOFF_MS && wants.some(w => w.route === x.routeId && (x.dirId == null || x.dirId === w.want))));
  }
  list.sort((p, q) => p.t - q.t);
  // the feed sometimes lists one train twice (status DUPLICATED): keep the real one
  list = list.filter(x => !x.dup || !list.some(o => o !== x && !o.dup && ((x.vehicleId && o.vehicleId === x.vehicleId) || Math.abs(o.t - x.t) < 180000))).slice(0, 10);
  S.arr = { key: tripKey(), at: t, list };
  const seenAlert = new Set();
  S.alerts = sortAlerts(situations.filter(s => s?.summary?.value && !seenAlert.has(s.id) && seenAlert.add(s.id)));
  for (const x of list.slice(0, 3)) { try { await fetchTrip(x.tripId); } catch { /* keep going */ } }
  const rest = list.slice(3).map(x => x.tripId).filter(id => !S.trips[id]);
  if (rest.length) setTimeout(async () => { for (const id of rest) { try { await fetchTrip(id); } catch { /* */ } } onMore?.(); }, 400);
}

// alerts that name a station on your trip come first
function sortAlerts(list) {
  const a = stationIdx(S.from), b = stationIdx(rideTo());
  const names = S.line && a >= 0 && b >= 0 ? S.line.stations.slice(Math.min(a, b), Math.max(a, b) + 1).map(s => s.name.toLowerCase().split(/[ /]/)[0]) : [];
  list.forEach(s => { const txt = (s.summary.value + ' ' + (s.description?.value || '')).toLowerCase(); s.mine = names.some(n => n.length > 3 && txt.includes(n)); });
  return list.sort((x, y) => (y.mine ? 1 : 0) - (x.mine ? 1 : 0));
}

/* ---------- which departures are real ----------
   One rule, used by the big countdown, the list and the map alike. */
const CUTOFF_MS = 30000;          // a row with no train position goes 30 s after its time
const HARD_CUTOFF_MS = 3 * 60000; // nothing stays longer than this after its time

// the train that will run this trip: already on it, or finishing the trip before it
export function trainFor(x) {
  if (!x) return null;
  if (S.trains[x.tripId]) return { v: S.trains[x.tripId], prior: false };
  for (const k in S.trains) if (S.trips[k]?.next === x.tripId) return { v: S.trains[k], prior: true };
  return null;
}

// when this trip leaves its first station
export function tripStart(x) {
  const tt = S.trips[x.tripId];
  if (tt?.st.length) return tt.sd + tt.st[0].d * 1000;
  const L = lineFor(x.routeId);
  for (const k in S.trips) {                    // no timetable yet: borrow the running time from a trip going the same way
    const o = S.trips[k];
    if (x.routeId && o.route && o.route !== x.routeId) continue;
    if (x.dirId && o.dirId && o.dirId !== x.dirId) continue;
    const i = o.st.findIndex(s => atStation(s.id, S.from, L));
    if (i >= 0) return (x.sched || x.t) - (o.st[i].d - o.st[0].d) * 1000;
  }
  return null;
}

// on the timetable, but its start time has passed and no train is running it or the trip before it
export function isGhost(x) {
  if (x.live || x.canceled || x.blockLive || trainFor(x)) return false;
  const start = tripStart(x);
  return start != null && now() > start + 60000;
}

// has the train for this row already gone past your station?
export function trainPassed(x) {
  const v = S.trains[x.tripId], L = v && lineFor(v.route), up = mainShape(L), a = stationIdx(S.from, L);
  if (!v || !up || a < 0) return false;
  const p = gpsFresh(v) ? v.gps : v.cur;
  if (!p) return false;
  const s = project(up, p).s, sa = L.stations[a].s;
  return isUp(v.dirId, v.route) ? s > sa + 80 : s < sa - 80;
}

export function isGone(x) {
  const t = now();
  if (x.t < t - HARD_CUTOFF_MS || passedStop(x) || trainPassed(x)) return true;
  const v = S.trains[x.tripId];
  if (v && (gpsFresh(v) || v.cur)) return false;   // we can see it hasn't reached the station yet
  return x.t < t - CUTOFF_MS;
}

export const upcoming = () => S.arr?.key === tripKey() ? S.arr.list.filter(x => !isGone(x) && !isGhost(x)) : [];

/* The big countdown is for a train that is actually reporting: timetable-only trips may never show. */
export function nextTrain() {
  const rows = upcoming().filter(x => !x.canceled && !x.dup);
  return rows.find(x => x.live) || rows[0] || null;
}
export const unconfirmedBefore = n => n ? upcoming().filter(x => !x.canceled && !x.dup && !x.live && x.t < n.t).length : 0;

// the departure row for a train, so every screen shows the same time for it
export const rowFor = tripId => S.arr?.key === tripKey() ? S.arr.list.find(x => x.tripId === tripId) || null : null;

export function arrivalAt(x) {
  const tt = S.trips[x.tripId], L = lineFor(tt?.route || x.routeId);
  if (tt) {
    let seenFrom = false;
    for (const s of tt.st) {
      if (atStation(s.id, S.from, L)) seenFrom = true;
      else if (seenFrom && atStation(s.id, rideTo(), L)) return tt.sd + (s.a + x.dev) * 1000;
    }
    return null;
  }
  // no timetable for this trip yet: use the travel time from any trip going the same way
  for (const k in S.trips) {
    const o = S.trips[k]; if (x.routeId && o.route && o.route !== x.routeId) continue;
    const st = o.st; let ia = -1;
    for (let i = 0; i < st.length; i++) {
      if (ia < 0 && atStation(st[i].id, S.from, L)) ia = i;
      else if (ia >= 0 && atStation(st[i].id, rideTo(), L)) return x.t + (st[i].a - st[ia].d) * 1000;
    }
  }
  return null;
}

// your train, or the train that will become it once it finishes its current trip
export const yourTrain = () => trainFor(nextTrain());

// "at Westlake" / "between X and Y", from where the train is drawn
export function whereText(v) {
  const L = lineFor(v.route), up = mainShape(L); if (!L || !up || !v.cur) return '';
  const s = project(up, v.cur).s, st = L.stations, n = st.length;
  const at = st.find(x => Math.abs(x.s - s) < 130);
  if (at) return { kind: 'at', a: at.name };
  for (let i = 0; i < n - 1; i++) {
    if (s > Math.min(st[i].s, st[i + 1].s) && s < Math.max(st[i].s, st[i + 1].s)) {
      const goingUp = isUp(v.dirId, v.route);
      return { kind: 'between', a: (goingUp ? st[i] : st[i + 1]).name, b: (goingUp ? st[i + 1] : st[i]).name };
    }
  }
  return { kind: 'near', a: st[s < st[0].s ? 0 : n - 1].name };
}

export const terminus = () => S.line?.stations.length ? (tripUp() ? S.line.stations.at(-1) : S.line.stations[0]).name : '';

/* ---------- a saved snapshot, so reopening the app shows something at once ---------- */
export function saveSnapshot() {
  const trips = {}, trains = {};
  for (const k in S.trains) {
    const { route, headsign, dirId, shapeId, predicted, dev, sObs, total, pos, gps, gpsAt } = S.trains[k];
    trains[k] = { tripId: k, route, headsign, dirId, shapeId, predicted, dev, sObs, total, pos, gps, gpsAt };
    if (S.trips[k]) trips[k] = S.trips[k];
  }
  S.arr?.list.forEach(x => { if (S.trips[x.tripId]) trips[x.tripId] = S.trips[x.tripId]; });
  store.set('snap', { at: Date.now(), trains, trips, arr: S.arr, lastOk: S.lastOk });
}
export function loadSnapshot() {
  const sn = store.get('snap', null);
  if (!sn || Date.now() - sn.at > 20 * 60000) return;
  S.trips = sn.trips || {};
  // trains saved more than 2 minutes ago are too old to show; timetables and departures are still useful
  if (Date.now() - sn.at < 2 * 60000) for (const k in sn.trains || {}) S.trains[k] = Object.assign(sn.trains[k], { f: new Follower({ backTolerance: 150 }), offset: 0 });
  for (const k in S.trains) anchor(S.trains[k], now());
  S.arr = sn.arr; S.lastOk = sn.lastOk || 0;
}
