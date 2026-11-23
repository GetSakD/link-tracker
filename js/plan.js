/* Directions with Transitous (a free, open trip planner), then each ride matched to the real
   bus or train in the live feed so you can see where it is and where to wait. */
import { CFG } from './config.js';
import { S, now } from './state.js';
import { oba, departures, routeName } from './api.js';
import { busItem } from './buses.js';
import { setGroup } from './fleet.js';
import { dist, inRegion, decodePolyline } from './util.js';

export async function geocode(q, near) {
  const r = await fetch(CFG.planner + 'geocode?text=' + encodeURIComponent(q) + '&place=' + near.lat.toFixed(4) + ',' + near.lon.toFixed(4));
  if (!r.ok) throw new Error("Search isn't available right now.");
  return ((await r.json()) || []).filter(x => x?.lat != null && inRegion(x)).slice(0, 12);    // Puget Sound only
}

export async function plan(from, to, mode) {
  const url = CFG.planner + 'plan?fromPlace=' + from.lat.toFixed(6) + ',' + from.lon.toFixed(6) + '&toPlace=' + to.lat.toFixed(6) + ',' + to.lon.toFixed(6) +
    '&time=' + encodeURIComponent(new Date(now()).toISOString()) + (mode === 'bus' ? '&transitModes=BUS' : '');
  const r = await fetch(url);
  if (!r.ok) throw new Error("The trip planner isn't available right now (" + r.status + ').');
  const j = await r.json(), seen = new Set();
  return (j.itineraries || []).filter(it => {
    const k = it.legs.map(l => (l.routeShortName || l.mode) + '@' + l.startTime).join('|');
    if (seen.has(k)) return false; seen.add(k);
    return Date.parse(it.endTime) > now();
  }).sort((p, q) => Date.parse(p.endTime) - Date.parse(q.endTime)).slice(0, 6);
}

export const isRide = l => l.mode !== 'WALK';
export const legMinutes = l => Math.max(1, Math.round((Date.parse(l.endTime) - Date.parse(l.startTime)) / 60000));
export const legColor = l => l.routeColor ? '#' + String(l.routeColor).replace('#', '') : (isRide(l) ? '#1A8597' : '#8E8E93');
export const legText = l => l.routeTextColor ? '#' + String(l.routeTextColor).replace('#', '') : '#FFFFFF';
export const legName = l => l.routeShortName || l.displayName || l.mode;
export const legPath = l => l.legGeometry ? decodePolyline(l.legGeometry.points, l.legGeometry.precision || 7) : [];
export const selectedItinerary = () => S.plan?.its?.[S.plan.sel] || null;
export const firstRide = () => selectedItinerary()?.legs.find(l => isRide(l) && Date.parse(l.endTime) > now()) || null;

const norm = s => String(s || '').toLowerCase().replace(/swift|line|route|[^a-z0-9]/g, '');
const sameRoute = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

/* For each upcoming ride: find the stop in the live feed, then the departure that is this ride. */
export async function trackPlanRides() {
  const P = S.plan, it = selectedItinerary(); if (!it) return;
  const sel = P.sel;
  for (const l of it.legs.filter(l => isRide(l) && Date.parse(l.endTime) > now())) {
    try {
      if (l.stop === undefined) {
        const r = await oba('stops-for-location', { lat: l.from.lat.toFixed(6), lon: l.from.lon.toFixed(6), radius: 150, maxCount: 30 });
        const best = (r.list || []).filter(s => (s.routeIds || []).some(id => sameRoute(routeName(S.routes[id]), legName(l))))
          .sort((a, b) => dist(a, l.from) - dist(b, l.from))[0];
        l.stop = best ? { id: best.id, name: best.name, code: best.code || '', dir: best.direction || '', lat: best.lat, lon: best.lon } : null;
      }
      if (!l.stop) continue;
      const { rows } = await departures(l.stop.id, 150, 10);
      const target = Date.parse(l.scheduledStartTime || l.startTime);
      const pick = rows.filter(x => sameRoute(routeName(S.routes[x.routeId]), legName(l)) && Math.abs(x.sched - target) < 6 * 60000)
        .sort((a, b) => Math.abs(a.sched - target) - Math.abs(b.sched - target))[0];
      l.live = pick || null;
    } catch { /* keep the timetable version of this ride */ }
    if (S.plan !== P || P.sel !== sel) return;
  }
  showPlanBuses();
}

export function showPlanBuses() {
  const it = selectedItinerary(), items = [];
  it?.legs.forEach((l, i) => {
    if (!isRide(l) || !l.live?.pos || l.live.canceled || Date.parse(l.endTime) < now()) return;
    items.push(busItem(S.plan.sel + ':' + i, l.live.pos, l.live.bearing, l.live.routeId, { color: legColor(l), text: legText(l), label: legName(l), sel: true }));
  });
  setGroup('plan', items);
}
