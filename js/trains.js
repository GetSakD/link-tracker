/* Live 2 Line trains and departures from your station. */
import { CFG } from './config.js';
import { S, now } from './state.js';
import { oba, indexRefs, departures } from './api.js';
import { stationIdx, stationOfStop, shape, mainShape, ensureShape, cacheTimetable, isUp, tripUp } from './line.js';
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

export function trainShape(v) {
  const L = S.line; if (!L) return null;
  const id = S.trips[v.tripId]?.shapeId || v.shapeId;
  const sh = id && shape(id);
  if (sh) return sh;
  if (id) ensureShape(id);
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

export function ingest(r) {
  const refs = indexRefs(r.references), seen = {}, t = now();
  for (const e of r.list || []) {
    const tr0 = refs.trips[e.tripId];
    if (e.schedule && tr0?.routeId === CFG.route && !S.trips[e.tripId]) cacheTimetable(e.tripId, e.schedule, e.serviceDate, tr0);
    const st = e.status; if (!st) continue;
    if (st.activeTripId && st.activeTripId !== e.tripId) continue;   // describes another trip; that trip's entry shows it
    if (!st.predicted && !st.vehicleId) continue;                    // timetable-only ghost: no train is reporting
    const trip = refs.trips[e.tripId];
    if (!trip || trip.routeId !== CFG.route) continue;               // same trains also run 1 Line trips
    if (seen[e.tripId] || /deadhead/i.test(st.phase || '') || /cancel/i.test(st.status || '')) continue;
    const gps = st.predicted && st.lastKnownLocation?.lat ? st.lastKnownLocation : null;
    const pos = gps || st.position; if (!pos) continue;
    seen[e.tripId] = 1;
    const v = S.trains[e.tripId] || (S.trains[e.tripId] = { tripId: e.tripId, f: new Follower({ backTolerance: 150 }), offset: 0 });
    Object.assign(v, {
      headsign: trip.tripHeadsign || '', dirId: String(trip.directionId), shapeId: trip.shapeId,
      predicted: !!st.predicted, dev: st.scheduleDeviation || 0, sObs: st.distanceAlongTrip, total: st.totalDistanceAlongTrip,
      pos: { lat: pos.lat, lon: pos.lon }, gps: gps ? { lat: gps.lat, lon: gps.lon } : null,
      gpsAt: st.lastLocationUpdateTime || st.lastUpdateTime || 0, vehicleId: st.vehicleId || ''
    });
    anchor(v, t);
  }
  for (const k in S.trains) if (!seen[k]) delete S.trains[k];
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

export async function refreshTrains(prefetched) {
  ingest(prefetched || await oba('trips-for-route/' + CFG.route, { includeStatus: 'true', includeSchedule: 'false' }));
  for (const id of Object.keys(S.trains).filter(k => !S.trips[k]).slice(0, 4)) { try { await fetchTrip(id); } catch { /* drawn at GPS until it loads */ } }
}

/* ---------- departures from your station ---------- */

export const tripKey = () => S.from + '>' + S.to;

export async function loadDepartures(onMore) {
  const L = S.line, a = stationIdx(S.from), b = stationIdx(S.to);
  if (!L || a < 0 || b < 0) return;
  const up = b > a, st = L.stations[a], stopId = up ? (st.up || st.down) : (st.down || st.up), want = up ? L.dirUp : L.dirDown;
  const { refs, rows } = await departures(stopId, 120);
  const t = now();
  let list = rows.filter(x => x.routeId === CFG.route && x.departs && (x.dirId == null || x.dirId === want) && x.t >= t - 60000).sort((p, q) => p.t - q.t);
  // the feed sometimes lists one train twice (status DUPLICATED): keep the real one
  list = list.filter(x => !x.dup || !list.some(o => o !== x && !o.dup && ((x.vehicleId && o.vehicleId === x.vehicleId) || Math.abs(o.t - x.t) < 180000))).slice(0, 8);
  S.arr = { key: tripKey(), at: t, list };
  S.alerts = sortAlerts(refs.situations.filter(s => s?.summary?.value));
  for (const x of list.slice(0, 3)) { try { await fetchTrip(x.tripId); } catch { /* keep going */ } }
  const rest = list.slice(3).map(x => x.tripId).filter(id => !S.trips[id]);
  if (rest.length) setTimeout(async () => { for (const id of rest) { try { await fetchTrip(id); } catch { /* */ } } onMore?.(); }, 400);
}

// alerts that name a station on your trip come first
function sortAlerts(list) {
  const a = stationIdx(S.from), b = stationIdx(S.to);
  const names = S.line && a >= 0 && b >= 0 ? S.line.stations.slice(Math.min(a, b), Math.max(a, b) + 1).map(s => s.name.toLowerCase().split(/[ /]/)[0]) : [];
  list.forEach(s => { const txt = (s.summary.value + ' ' + (s.description?.value || '')).toLowerCase(); s.mine = names.some(n => n.length > 3 && txt.includes(n)); });
  return list.sort((x, y) => (y.mine ? 1 : 0) - (x.mine ? 1 : 0));
}

export const upcoming = () => S.arr?.key === tripKey() ? S.arr.list.filter(x => x.t >= now() - 60000) : [];

/* The big countdown is for a train that is actually reporting: timetable-only trips may never show. */
export function nextTrain() {
  const rows = upcoming().filter(x => !x.canceled && !x.dup && x.t >= now() - 30000);
  return rows.find(x => x.live) || rows[0] || null;
}
export const unconfirmedBefore = n => n ? upcoming().filter(x => !x.canceled && !x.dup && !x.live && x.t >= now() - 30000 && x.t < n.t).length : 0;

export function arrivalAt(x) {
  const a = stationIdx(S.from), b = stationIdx(S.to), tt = S.trips[x.tripId];
  if (tt) {
    let seenFrom = false;
    for (const s of tt.st) {
      const k = stationOfStop(s.id);
      if (k === a) seenFrom = true;
      else if (k === b && seenFrom) return tt.sd + (s.a + x.dev) * 1000;
    }
    return null;
  }
  // no timetable for this trip yet: use the travel time from any trip going the same way
  for (const k in S.trips) {
    const st = S.trips[k].st; let ia = -1;
    for (let i = 0; i < st.length; i++) {
      const s = stationOfStop(st[i].id);
      if (s === a && ia < 0) ia = i;
      else if (s === b && ia >= 0) return x.t + (st[i].a - st[ia].d) * 1000;
    }
  }
  return null;
}

// your train, or the train that will become it once it finishes its current trip
export function yourTrain() {
  const n = nextTrain(); if (!n) return null;
  if (S.trains[n.tripId]) return { v: S.trains[n.tripId], prior: false };
  for (const k in S.trains) if (S.trips[k]?.next === n.tripId) return { v: S.trains[k], prior: true };
  return null;
}

// "at Westlake" / "between X and Y", from where the train is drawn
export function whereText(v) {
  const L = S.line, up = mainShape(); if (!L || !up || !v.cur) return '';
  const s = project(up, v.cur).s, st = L.stations, n = st.length;
  const at = st.find(x => Math.abs(x.s - s) < 130);
  if (at) return { kind: 'at', a: at.name };
  for (let i = 0; i < n - 1; i++) {
    if (s > Math.min(st[i].s, st[i + 1].s) && s < Math.max(st[i].s, st[i + 1].s)) {
      const goingUp = isUp(v.dirId);
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
    const { headsign, dirId, shapeId, predicted, dev, sObs, total, pos, gps, gpsAt } = S.trains[k];
    trains[k] = { tripId: k, headsign, dirId, shapeId, predicted, dev, sObs, total, pos, gps, gpsAt };
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
