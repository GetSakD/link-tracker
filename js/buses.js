/* Buses: stops near you, a stop's next buses, and finding one bus to follow. */
import { CFG } from './config.js';
import { S, now } from './state.js';
import { oba, indexRefs, departures, vehicleFrom, routeName, routeColor, routeText, byRouteName } from './api.js';
import { setGroup } from './fleet.js';
import { dist } from './util.js';

/* ---------- stops ---------- */
const CELL = 0.012, fetched = new Set();

export async function stopsAround(lat, lon, radius) {
  const r = await oba('stops-for-location', { lat: lat.toFixed(5), lon: lon.toFixed(5), radius: Math.round(radius), maxCount: 250 });
  for (const s of r.list || []) {
    const routes = (s.routeIds || []).filter(id => Number(S.routes[id]?.type) === 3);   // type 3 = bus
    if (routes.length) S.stops[s.id] = { id: s.id, name: s.name, lat: s.lat, lon: s.lon, dir: s.direction || '', code: s.code || '', routes: routes.sort(byRouteName) };
  }
}

/* Fill the visible map with stops, a grid cell at a time, nearest cells first. */
export async function stopsInView(b, center, onCell) {
  const cells = [];
  for (let la = Math.floor(b.s / CELL); la <= Math.floor(b.n / CELL); la++)
    for (let lo = Math.floor(b.w / CELL); lo <= Math.floor(b.e / CELL); lo++) if (!fetched.has(la + ',' + lo)) cells.push([la, lo]);
  const d = c => Math.hypot((c[0] + .5) * CELL - center.lat, (c[1] + .5) * CELL - center.lon);
  cells.sort((p, q) => d(p) - d(q));
  for (const c of cells.slice(0, 10)) {
    const k = c.join(','); fetched.add(k);
    try { await stopsAround((c[0] + .5) * CELL, (c[1] + .5) * CELL, 900); onCell?.(); }
    catch (e) { fetched.delete(k); throw e; }
    if (S.mode !== 'buses') return;
  }
}

export const nearbyStops = (p, n = 8) => Object.values(S.stops).map(s => ({ s, d: dist(s, p) })).sort((a, b) => a.d - b.d).slice(0, n);

export async function loadStopDepartures() {
  const id = S.stop; if (!id) return;
  const { rows } = await departures(id, 90);
  if (id !== S.stop) return;
  S.stopArr = { id, at: now(), list: rows.filter(x => x.departs && x.t >= now() - 60000).sort((p, q) => p.t - q.t).slice(0, 30) };
  showStopBuses();
}

// the buses heading to the selected stop, on the map
export function showStopBuses() {
  const list = S.mode === 'buses' && !S.track && S.stopArr?.id === S.stop ? S.stopArr.list : [];
  const seen = new Set(), items = [];
  for (const x of list) {
    if (!x.pos || x.canceled || items.length >= 10 || seen.has(x.tripId)) continue;
    if (S.routeFilter !== 'all' && x.routeId !== S.routeFilter) continue;
    seen.add(x.tripId);
    items.push(busItem(x.tripId, x.pos, x.bearing, x.routeId));
  }
  setGroup('stop', items);
}

export function busItem(id, pos, bearing, routeId, extra = {}) {
  const r = S.routes[routeId];
  return { id, lat: pos.lat, lon: pos.lon, bearing, color: routeColor(r), text: routeText(r), label: routeName(r), ...extra };
}

/* ---------- find one bus (by route or the number painted on it) and follow it ---------- */
export const trackedBus = () => S.track?.sel ? S.track.vehicles.find(v => v.tripId === S.track.sel) || null : null;

export async function findBus(q, center) {
  q = String(q || '').trim(); if (!q) return;
  S.track = { q, loading: true, routes: [], vehicles: [], sel: null, follow: false, err: null };
  S.stop = null; S.stopArr = null;
  showStopBuses();
  const T = S.track;
  try {
    if (/^\d{4,5}$/.test(q)) {
      // ask every agency at once
      const found = await Promise.all(CFG.agencies.map(ag =>
        oba('trip-for-vehicle/' + ag + '_' + q, { includeStatus: true, includeSchedule: false })
          .then(d => vehicleFrom(d.entry?.tripId, d.entry?.status, indexRefs(d.references)), e => { if (e.fatal && !e.notFound) throw e; return null; })));
      const v = found.find(Boolean);
      if (v) Object.assign(T, { vehicles: [v], sel: v.tripId, follow: true, vehicleId: v.vehicleId, routes: [v.routeId] });
    }
    if (!T.vehicles.length) {
      const want = q.toLowerCase().replace(/^route\s*/, '').trim();
      const same = r => { const n = routeName(r).toLowerCase(); return n === want || n === want + ' line' || n.replace(/ line$/, '') === want.replace(/ line$/, ''); };
      let ids = Object.keys(S.routes).filter(id => same(S.routes[id]));
      if (!ids.length) {
        const rd = await oba('routes-for-location', { lat: center.lat.toFixed(5), lon: center.lon.toFixed(5), radius: 25000, query: /^[a-z]$/.test(want) ? want.toUpperCase() + ' Line' : want });
        for (const r of rd.list || []) { S.routes[r.id] = r; if (same(r)) ids.push(r.id); }
      }
      ids = [...new Set(ids)].filter(id => !CFG.otherLinkRoutes.includes(id)).slice(0, 3);
      if (!ids.length) throw new Error('No route "' + q + '" found near you.');
      T.routes = ids;
      await loadRouteBuses(T);
    }
  } catch (e) { T.err = e.message || String(e); }
  T.loading = false;
  if (S.track === T) showTrackedBuses();
}

async function loadRouteBuses(T) {
  const all = [];
  for (const id of T.routes) {
    const d = await oba('trips-for-route/' + id, { includeStatus: true, includeSchedule: false }), refs = indexRefs(d.references);
    for (const x of d.list || []) {
      const v = vehicleFrom(x.tripId, x.status, refs);
      if (v && !all.some(o => o.vehicleId && o.vehicleId === v.vehicleId)) all.push(v);
    }
  }
  if (S.me) all.sort((p, q) => dist(p.pos, S.me) - dist(q.pos, S.me));
  T.vehicles = all;
}

export async function refreshTrackedBus() {
  const T = S.track; if (!T || T.loading) return;
  const sel = trackedBus();
  if (sel?.vehicleId) {
    const d = await oba('trip-for-vehicle/' + sel.vehicleId, { includeStatus: true, includeSchedule: false });
    const v = vehicleFrom(d.entry?.tripId, d.entry?.status, indexRefs(d.references));
    if (S.track !== T) return;
    if (v) { T.vehicles = T.vehicles.map(o => o.vehicleId === v.vehicleId ? v : o); T.sel = v.tripId; }
  } else if (T.routes.length) await loadRouteBuses(T);
  if (S.track === T) showTrackedBuses();
}

export function showTrackedBuses() {
  const T = S.track;
  const list = !T ? [] : T.sel ? T.vehicles.filter(v => v.tripId === T.sel) : T.vehicles.slice(0, 40);
  setGroup('track', list.map(v => busItem(v.tripId, v.pos, v.bearing, v.routeId, { at: v.at, shapeId: v.shapeId, sel: v.tripId === T.sel })));
}

export function stopTracking() { S.track = null; showTrackedBuses(); }
