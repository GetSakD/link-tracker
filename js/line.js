/* The 2 Line itself: stations (with a platform each way), track shapes and timetables. */
import { CFG, STATION_ALIASES } from './config.js';
import { S } from './state.js';
import { oba, indexRefs } from './api.js';
import { store, dist, decodePolyline, makeShape, project } from './util.js';

export const stationIdx = name => S.line ? S.line.stations.findIndex(s => s.name === name) : -1;
export const tripUp = () => stationIdx(S.to) > stationIdx(S.from);              // toward Lynnwood
export const isUp = dirId => !!S.line && dirId === S.line.dirUp;
export const hasTrip = () => !!S.line && stationIdx(S.from) >= 0 && stationIdx(S.to) >= 0 && S.from !== S.to;

export function stationOfStop(stopId) {
  const L = S.line; if (!L) return -1;
  if (L.stopIdx[stopId] != null) return L.stopIdx[stopId];
  const info = S.stopInfo[stopId]; if (!info) return -1;
  let best = -1, bd = 450;
  L.stations.forEach((st, i) => { const d = dist(st, info); if (d < bd) { bd = d; best = i; } });
  return (L.stopIdx[stopId] = best);
}

export function shape(id) {
  const sh = S.line?.shapes[id];
  if (sh && !sh.cum) Object.assign(sh, makeShape(sh.pts));
  return sh || null;
}
export const mainShape = () => shape(S.line?.shapeUp);

function install(L) {
  L.stopIdx = {};
  L.stations.forEach((st, i) => { if (st.up) L.stopIdx[st.up] = i; if (st.down) L.stopIdx[st.down] = i; });
  S.line = L;
  const up = mainShape();
  if (up) L.stations.forEach(st => { st.s = project(up, st).s; });
}
function save(L) {
  store.set('line', { v: 3, at: L.at, stations: L.stations.map(({ name, lat, lon, up, down }) => ({ name, lat, lon, up, down })),
    shapes: Object.fromEntries(Object.entries(L.shapes).map(([k, v]) => [k, { pts: v.pts }])), dirUp: L.dirUp, dirDown: L.dirDown, shapeUp: L.shapeUp, shapeDown: L.shapeDown });
}

/* Platforms: walk one direction's stop list in order, then pair the other direction's platforms by name or proximity. */
function buildStations(upStops, downStops) {
  const stations = [];
  upStops.forEach(([id, s]) => { if (s && !stations.some(q => q.name === s.name)) stations.push({ name: s.name, lat: s.lat, lon: s.lon, up: id, down: null }); });
  downStops.forEach(([id, s]) => {
    if (!s) return;
    let i = stations.findIndex(q => q.name === s.name);
    if (i < 0) { let bd = 450; stations.forEach((q, j) => { const d = dist(q, s); if (d < bd) { bd = d; i = j; } }); }
    if (i >= 0 && !stations[i].down) stations[i].down = id;
  });
  return stations;
}

export function cacheTimetable(tripId, sched, serviceDate, trip) {
  if (!sched?.stopTimes?.length) return;
  S.trips[tripId] = {
    st: sched.stopTimes.map(x => ({ id: x.stopId, a: x.arrivalTime, d: x.departureTime, s: x.distanceAlongTrip })),
    sd: serviceDate, next: sched.nextTripId || null,
    shapeId: trip?.shapeId || null, dirId: trip ? String(trip.directionId) : null, headsign: trip?.tripHeadsign || ''
  };
}

/* Load the line. Returns the trips-for-route response when it fetched one, so the caller can reuse it. */
export async function loadLine(force) {
  const cached = store.get('line', null);
  if (!force && cached?.v === 3 && Date.now() - cached.at < 7 * 864e5) { install(cached); return null; }
  const r = await oba('trips-for-route/' + CFG.route, { includeStatus: 'true', includeSchedule: 'true' });
  const refs = indexRefs(r.references), best = { up: null, down: null };
  for (const e of r.list || []) {
    const trip = refs.trips[e.tripId];
    if (!trip || trip.routeId !== CFG.route || !e.schedule) continue;
    cacheTimetable(e.tripId, e.schedule, e.serviceDate, trip);
    const st = e.schedule.stopTimes || [];
    if (st.length < 5) continue;
    const first = refs.stops[st[0].stopId], last = refs.stops[st[st.length - 1].stopId];
    if (!first || !last) continue;
    const k = dist(last, CFG.north) < 900 ? 'up' : dist(first, CFG.north) < 900 ? 'down' : null;
    if (k && (!best[k] || st.length > best[k].st.length)) best[k] = { trip, st };
  }
  let L;
  if (!best.up && !best.down) {
    if (cached) { install(cached); return r; }
    L = await lineFromStops();                       // no trains running (night): use the route's stop list
  } else {
    const stops = x => x ? x.st.map(t => [t.stopId, refs.stops[t.stopId]]) : [];
    const upStops = best.up ? stops(best.up) : stops(best.down).reverse();
    L = { v: 3, at: Date.now(), stations: buildStations(upStops, best.up ? stops(best.down) : []), shapes: {},
      dirUp: best.up ? String(best.up.trip.directionId) : String(1 - Number(best.down.trip.directionId)),
      dirDown: best.down ? String(best.down.trip.directionId) : String(1 - Number(best.up.trip.directionId)),
      shapeUp: best.up?.trip.shapeId || null, shapeDown: best.down?.trip.shapeId || null };
    if (!best.up) L.stations.forEach(st => { st.down = st.up; st.up = null; });
    for (const id of [L.shapeUp, L.shapeDown].filter(Boolean)) {
      const sh = await oba('shape/' + encodeURIComponent(id));
      L.shapes[id] = { pts: decodePolyline(sh.entry?.points) };
    }
    if (!L.shapeUp) { L.shapeUp = L.shapeDown + '~rev'; L.shapes[L.shapeUp] = { pts: L.shapes[L.shapeDown].pts.slice().reverse() }; }
  }
  save(L); install(L);
  return r;
}

async function lineFromStops() {
  const d = await oba('stops-for-route/' + CFG.route, { includePolylines: 'true', version: '2' });
  const refs = indexRefs(d.references), groups = d.entry?.stopGroupings?.[0]?.stopGroups || [];
  if (!groups.length) throw new Error("Couldn't load the 2 Line stations. Try again in a minute.");
  const lastStop = g => refs.stops[(g.stopIds || []).at(-1)];
  const up = groups.find(g => lastStop(g) && dist(lastStop(g), CFG.north) < 900) || groups[0];
  const down = groups.find(g => g !== up) || null;
  const ids = g => (g?.stopIds || []).map(id => [id, refs.stops[id]]);
  const poly = g => (g?.polylines || []).flatMap(p => decodePolyline(p.points));
  const pu = poly(up);
  return { v: 3, at: Date.now(), stations: buildStations(ids(up), ids(down)),
    shapes: { 'grp-up': { pts: pu }, 'grp-down': { pts: down ? poly(down) : pu.slice().reverse() } },
    dirUp: String(up.id ?? '1'), dirDown: String(down?.id ?? (up.id === '0' ? '1' : '0')), shapeUp: 'grp-up', shapeDown: 'grp-down' };
}

export function restoreLine() {
  const c = store.get('line', null);
  if (c?.v !== 3) return false;
  install(c);
  return Date.now() - (c.at || 0) > 7 * 864e5;        // true: stale, refresh in the background
}

const pendingShapes = {};
export async function ensureShape(id) {
  if (!id || !S.line || S.line.shapes[id] || pendingShapes[id]) return;
  pendingShapes[id] = 1;
  try { const sh = await oba('shape/' + encodeURIComponent(id)); S.line.shapes[id] = { pts: decodePolyline(sh.entry?.points) }; }
  catch { /* the main track shape stands in */ }
  finally { delete pendingShapes[id]; }
}

export function stationMatches(name, q) {
  let hay = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  STATION_ALIASES.forEach(([re, extra]) => { if (re.test(name)) hay += ' ' + extra; });
  const words = hay.split(/\s+/);
  return q.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).every(w => words.some(h => h.startsWith(w)));
}
export function nearestStation(p) {
  if (!S.line || !p) return -1;
  let best = -1, bd = Infinity;
  S.line.stations.forEach((st, i) => { const d = dist(st, p); if (d < bd) { bd = d; best = i; } });
  return best;
}
