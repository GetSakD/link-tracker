/* Sound Transit's train lines: stations (a platform each way), track shapes and timetables.
   S.lines holds every line, keyed by route id. S.line is the line your trip rides; when two lines
   serve both of your stations (the 1 and 2 Lines share Lynnwood – International District), both count. */
import { CFG, STATION_ALIASES } from './config.js';
import { S, emit } from './state.js';
import { oba, indexRefs } from './api.js';
import { store, dist, decodePolyline, makeShape, project } from './util.js';

const V = 4;                                   // saved-data version
const WEEK = 7 * 864e5;

/* ---------- looking things up ---------- */
export const lineOf = routeId => (routeId && S.lines[routeId]) || null;
export const stationIdx = (name, L = S.line) => L ? L.stations.findIndex(s => s.name === name) : -1;
export const stationLines = name => S.lineOrder.filter(id => stationIdx(name, S.lines[id]) >= 0);
const linesBetween = (x, y) => !x || !y || x === y ? [] :
  S.lineOrder.filter(id => stationIdx(x, S.lines[id]) >= 0 && stationIdx(y, S.lines[id]) >= 0);
// lines that go from your station to your destination without changing trains
export const directLines = () => linesBetween(S.from, S.to);
// where the train you board takes you: your destination, or the station where you change trains
export const rideTo = () => directLines().length ? S.to : (transferFor()?.station || S.to);
// the lines you can board for that ride (the 1 and 2 Lines both run Lynnwood – International District)
export const tripLines = () => linesBetween(S.from, rideTo());
export const canRide = () => tripLines().length > 0;
export const hasTrip = () => !!S.line && !!S.from && !!S.to && S.from !== S.to && stationLines(S.from).length > 0 && stationLines(S.to).length > 0;
export const tripUp = () => stationIdx(rideTo()) > stationIdx(S.from);   // northbound (toward Lynnwood on the 1 and 2 Lines)
export const isUp = (dirId, routeId) => { const L = lineOf(routeId) || S.line; return !!L && dirId === L.dirUp; };

// pick the line for your trip: one that serves both stations, else the one at your starting station
export function chooseLine() {
  const id = tripLines()[0] || stationLines(S.from)[0] || stationLines(S.to)[0] || S.lineOrder[0];
  S.line = S.lines[id] || null;
  return S.line;
}

// every station once, in line order, with the lines that stop there
export function allStations() {
  const out = [], seen = new Map();
  for (const id of S.lineOrder) for (const st of S.lines[id].stations) {
    if (seen.has(st.name)) { seen.get(st.name).lines.push(id); continue; }
    const e = { name: st.name, lat: st.lat, lon: st.lon, lines: [id] };
    seen.set(st.name, e); out.push(e);
  }
  return out;
}

// no single train goes there: where to change, and which lines
export function transferFor() {
  if (!S.from || !S.to || S.from === S.to || directLines().length) return null;
  let best = null;
  for (const a of stationLines(S.from)) for (const b of stationLines(S.to)) {
    const A = S.lines[a], B = S.lines[b];
    for (const st of A.stations) {
      if (stationIdx(st.name, B) < 0 || st.name === S.from || st.name === S.to) continue;
      // fewest stops overall
      const n = Math.abs(stationIdx(st.name, A) - stationIdx(S.from, A)) + Math.abs(stationIdx(S.to, B) - stationIdx(st.name, B));
      if (!best || n < best.n) best = { n, station: st.name, first: a, second: b };
    }
  }
  return best;
}

export function stationOfStop(stopId, L = S.line) {
  if (!L) return -1;
  if (L.stopIdx[stopId] != null) return L.stopIdx[stopId];
  const info = S.stopInfo[stopId]; if (!info) return -1;
  let best = -1, bd = 450;
  L.stations.forEach((st, i) => { const d = dist(st, info); if (d < bd) { bd = d; best = i; } });
  return (L.stopIdx[stopId] = best);
}

/* ---------- names and colours ---------- */
export const lineName = routeId => lineOf(routeId)?.name || '';
export const lineBadge = routeId => { const n = lineName(routeId); return (n.match(/^(\S+)\s+Line$/i)?.[1] || n.slice(0, 1) || '?').toUpperCase(); };
export const lineColor = routeId => lineOf(routeId)?.color || '#007CAD';
export const lineText = routeId => lineOf(routeId)?.text || '#FFFFFF';

/* ---------- track shapes (shared by every line) ---------- */
export function shape(id) {
  const sh = id && S.shapes[id];
  if (sh && !sh.cum) Object.assign(sh, makeShape(sh.pts));
  return sh || null;
}
export const mainShape = (L = S.line) => shape(L?.shapeUp);

function install(L) {
  L.stopIdx = {};
  L.stations.forEach((st, i) => { if (st.up) L.stopIdx[st.up] = i; if (st.down) L.stopIdx[st.down] = i; });
  for (const [k, v] of Object.entries(L.shapes)) if (!S.shapes[k]) S.shapes[k] = v;
  L.shapes = {};                                  // they live in S.shapes now
  S.lines[L.route] = L;
  const up = mainShape(L);
  if (up) L.stations.forEach(st => { st.s = project(up, st).s; });
}
function save(L) {
  const shapes = {};
  for (const id of [L.shapeUp, L.shapeDown]) if (id && S.shapes[id]) shapes[id] = { pts: S.shapes[id].pts };
  store.set('ln:' + L.route, { v: V, at: L.at, route: L.route, name: L.name, long: L.long, color: L.color, text: L.text,
    stations: L.stations.map(({ name, lat, lon, up, down }) => ({ name, lat, lon, up, down })),
    shapes: Object.fromEntries(Object.entries({ ...L.shapes, ...shapes }).map(([k, v]) => [k, { pts: v.pts }])),
    dirUp: L.dirUp, dirDown: L.dirDown, shapeUp: L.shapeUp, shapeDown: L.shapeDown });
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
    sd: serviceDate, next: sched.nextTripId || null, route: trip?.routeId || null,
    shapeId: trip?.shapeId || null, dirId: trip ? String(trip.directionId) : null, headsign: trip?.tripHeadsign || ''
  };
}

/* ---------- which train lines exist ----------
   Sound Transit's rail routes (Link light rail, the T Line, Sounder), found at startup so new lines appear by themselves. */
const FALLBACK = [
  { id: '40_100479', shortName: '1 Line', longName: 'Lynnwood City Center - Federal Way Downtown', color: '28813F', textColor: 'FFFFFF', type: 0 },
  { id: '40_2LINE', shortName: '2 Line', longName: 'Lynnwood City Center - Downtown Redmond', color: '007CAD', textColor: 'FFFFFF', type: 0 }
];
const order = r => { const n = r.shortName || r.longName || ''; return (/^\d/.test(n) ? '0' : /^[A-Z] Line/i.test(n) ? '1' : '2') + n.padStart(8); };
const meta = r => ({ route: r.id, name: r.shortName || r.longName || 'Train', long: r.longName || '', color: '#' + (r.color || '007CAD'), text: '#' + (r.textColor || 'FFFFFF') });

export async function discoverLines(force) {
  const c = store.get('railRoutes', null);
  if (!force && c?.v === V && Date.now() - c.at < WEEK && c.list?.length) return c.list;
  let list;
  try {
    const r = await oba('routes-for-agency/40');
    list = (r.list || []).filter(x => [0, 1, 2, 12].includes(Number(x.type)));
  } catch { list = null; }
  if (!list?.length) list = c?.list?.length ? c.list : FALLBACK;
  list = list.slice().sort((a, b) => order(a) < order(b) ? -1 : 1).map(x => ({ ...x, ...meta(x) }));
  store.set('railRoutes', { v: V, at: Date.now(), list });
  return list;
}
export const railRoutes = () => S.railRoutes;

/* Load one line. Returns the trips-for-route response it fetched, so trains can be read from it too. */
export async function loadLine(m, force) {
  const cached = store.get('ln:' + m.route, null);
  if (!force && cached?.v === V && Date.now() - cached.at < WEEK) { install(cached); return null; }
  const r = await oba('trips-for-route/' + m.route, { includeStatus: 'true', includeSchedule: 'true' });
  const refs = indexRefs(r.references), best = { up: null, down: null };
  for (const e of r.list || []) {
    const trip = refs.trips[e.tripId];
    if (!trip || trip.routeId !== m.route || !e.schedule) continue;
    cacheTimetable(e.tripId, e.schedule, e.serviceDate, trip);
    const st = e.schedule.stopTimes || [];
    if (st.length < 3) continue;
    const first = refs.stops[st[0].stopId], last = refs.stops[st[st.length - 1].stopId];
    if (!first || !last) continue;
    // "up" is northbound: toward Lynnwood on the 1 and 2 Lines, Everett on Sounder
    const k = last.lat > first.lat + 0.004 ? 'up' : first.lat > last.lat + 0.004 ? 'down' : null;
    if (k && (!best[k] || st.length > best[k].st.length)) best[k] = { trip, st };
  }
  let L;
  if (!best.up && !best.down) {
    if (cached?.v === V) { install(cached); return r; }
    L = await lineFromStops(m);                       // no trains running (night): use the route's stop list
  } else {
    const stops = x => x ? x.st.map(t => [t.stopId, refs.stops[t.stopId]]) : [];
    const upStops = best.up ? stops(best.up) : stops(best.down).reverse();
    L = { v: V, at: Date.now(), ...m, stations: buildStations(upStops, best.up ? stops(best.down) : []), shapes: {},
      dirUp: best.up ? String(best.up.trip.directionId) : String(1 - Number(best.down.trip.directionId)),
      dirDown: best.down ? String(best.down.trip.directionId) : String(1 - Number(best.up.trip.directionId)),
      shapeUp: best.up?.trip.shapeId || null, shapeDown: best.down?.trip.shapeId || null };
    if (!best.up) L.stations.forEach(st => { st.down = st.up; st.up = null; });
    for (const id of [L.shapeUp, L.shapeDown].filter(Boolean)) {
      const sh = S.shapes[id] || { pts: decodePolyline((await oba('shape/' + encodeURIComponent(id))).entry?.points) };
      L.shapes[id] = { pts: sh.pts };
    }
    if (!L.shapeUp) { L.shapeUp = L.shapeDown + '~rev'; L.shapes[L.shapeUp] = { pts: L.shapes[L.shapeDown].pts.slice().reverse() }; }
  }
  install(L); save(L);
  return r;
}

async function lineFromStops(m) {
  const d = await oba('stops-for-route/' + m.route, { includePolylines: 'true', version: '2' });
  const refs = indexRefs(d.references), groups = d.entry?.stopGroupings?.[0]?.stopGroups || [];
  if (!groups.length) throw new Error(`Couldn't load the ${m.name} stations. Try again in a minute.`);
  const lastStop = g => refs.stops[(g.stopIds || []).at(-1)], firstStop = g => refs.stops[(g.stopIds || [])[0]];
  const north = g => (lastStop(g)?.lat || 0) - (firstStop(g)?.lat || 0);
  const up = groups.slice().sort((a, b) => north(b) - north(a))[0];
  const down = groups.find(g => g !== up) || null;
  const ids = g => (g?.stopIds || []).map(id => [id, refs.stops[id]]);
  const poly = g => (g?.polylines || []).flatMap(p => decodePolyline(p.points));
  const pu = poly(up), k = m.route;
  return { v: V, at: Date.now(), ...m, stations: buildStations(ids(up), ids(down)),
    shapes: { [k + '~up']: { pts: pu }, [k + '~down']: { pts: down ? poly(down) : pu.slice().reverse() } },
    dirUp: String(up.id ?? '1'), dirDown: String(down?.id ?? (up.id === '0' ? '1' : '0')), shapeUp: k + '~up', shapeDown: k + '~down' };
}

/* Load every line. Lines your stations are on (or, on a first start, the first two Link lines) load
   right away; the rest follow in the background and announce themselves with 'linesChanged'.
   Returns { routeId: trips-for-route response } for the lines loaded now. */
let background = null;
export async function loadLines(force) {
  const list = await discoverLines(force);
  S.railRoutes = new Set(list.map(x => x.route));
  const known = new Set([...stationLines(S.from), ...stationLines(S.to)]);
  const now = list.filter(m => known.size ? known.has(m.route) : list.indexOf(m) < 2);
  const later = list.filter(m => !now.includes(m));
  const fresh = {};
  for (const m of now) {
    if (S.lines[m.route] && !force) continue;
    const r = await loadLine(m, force); if (r) fresh[m.route] = r;
  }
  S.lineOrder = list.map(x => x.route).filter(id => S.lines[id]);
  chooseLine();
  if (!background) background = (async () => {
    let added = false;
    for (const m of later) {
      if (S.lines[m.route] && !force) continue;
      try { await loadLine(m, force); added = true; } catch { /* that line stays off the map until next time */ }
    }
    S.lineOrder = list.map(x => x.route).filter(id => S.lines[id]);
    if (added) { chooseLine(); emit('linesChanged'); }
  })().finally(() => { background = null; });
  return fresh;
}

// from the phone's saved copy: instant start. Returns true when it's a week old (refresh it quietly).
export function restoreLines() {
  store.del('line');                                   // the single-line format from before
  const c = store.get('railRoutes', null);
  if (c?.v !== V || !c.list?.length) return false;
  let stale = Date.now() - c.at > WEEK;
  for (const m of c.list) {
    const L = store.get('ln:' + m.route, null);
    if (L?.v === V) { install(L); stale = stale || Date.now() - L.at > WEEK; }
  }
  S.lineOrder = c.list.map(x => x.route).filter(id => S.lines[id]);
  S.railRoutes = new Set(c.list.map(x => x.route));
  if (!S.lineOrder.length) return false;
  chooseLine();
  return stale;
}
export function forgetLines() {
  for (const id of Object.keys(S.lines)) store.del('ln:' + id);
  store.del('railRoutes'); store.del('line');
  S.lines = {}; S.lineOrder = []; S.line = null; S.shapes = {};
}

/* ---------- other trips' tracks, loaded on demand ---------- */
const pendingShapes = {};
const failedShapes = {};
export const shapeFailed = id => !!failedShapes[id] && Date.now() - failedShapes[id] < 120000;   // try again after 2 min
// loads a trip's track once; callers asking at the same time share the request
export function ensureShape(id) {
  if (!id || S.shapes[id]) return Promise.resolve();
  return pendingShapes[id] || (pendingShapes[id] = (async () => {
    try {
      const sh = await oba('shape/' + encodeURIComponent(id)), pts = decodePolyline(sh.entry?.points);
      if (pts.length > 1) S.shapes[id] = { pts }; else failedShapes[id] = Date.now();
    } catch { failedShapes[id] = Date.now(); }      // the line's own track stands in
    finally { delete pendingShapes[id]; }
  })());
}

export function stationMatches(name, q) {
  let hay = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  STATION_ALIASES.forEach(([re, extra]) => { if (re.test(name)) hay += ' ' + extra; });
  const words = hay.split(/\s+/);
  return q.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).every(w => words.some(h => h.startsWith(w)));
}
// the closest station on any line (its name)
export function nearestStation(p) {
  if (!p) return null;
  let best = null, bd = Infinity;
  for (const st of allStations()) { const d = dist(st, p); if (d < bd) { bd = d; best = st.name; } }
  return best;
}
