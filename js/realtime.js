/* A second source of live times. OneBusAway carries no live data for some agencies (Community
   Transit's buses, including Swift, show only timetable times there). Transitous, the open trip
   planner, does ingest those agencies' live feeds, so for any departure still without a live time
   we ask Transitous what's leaving that stop and match by route and timetable time. */
import { CFG } from './config.js';
import { now } from './state.js';
import { dist } from './util.js';

const v = n => CFG.planner.replace(/\/v\d+\/$/, '/v' + n + '/');
const idCache = new Map();          // OneBusAway stop -> Transitous stop id (or null)
const norm = s => String(s || '').toLowerCase().replace(/swift|line|route|[^a-z0-9]/g, '');

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
  return r.json();
}

// older servers: find the stop id by name near the stop, then ask by id
async function stopIdFor(stop) {
  if (idCache.has(stop.id)) return idCache.get(stop.id);
  let id = null;
  try {
    const list = await json(v(1) + 'geocode?text=' + encodeURIComponent(stop.name) + '&type=STOP&place=' + stop.lat.toFixed(5) + ',' + stop.lon.toFixed(5) + '&placeBias=8');
    const best = list.filter(x => dist(x, stop) < 150).sort((a, b) => dist(a, stop) - dist(b, stop))[0];
    id = best?.id || null;
  } catch { /* none */ }
  idCache.set(stop.id, id);
  return id;
}

async function stopTimes(stop) {
  const t = encodeURIComponent(new Date(now() - 60000).toISOString());
  try { return (await json(v(6) + `stoptimes?center=${stop.lat.toFixed(6)},${stop.lon.toFixed(6)}&radius=40&n=40&time=${t}`)).stopTimes || []; }
  catch {
    const id = await stopIdFor(stop); if (!id) return [];
    return (await json(v(5) + `stoptimes?stopId=${encodeURIComponent(id)}&n=40&time=${t}`)).stopTimes || [];
  }
}

/* rows: parsed departures from OneBusAway; name(row) gives its route's short name.
   Fills in live time and delay for rows that have none. Returns how many it filled. */
export async function fillLiveTimes(stop, rows, name) {
  const need = rows.filter(r => !r.live && !r.canceled);
  if (!need.length || !stop?.lat) return 0;
  let list;
  try { list = (await stopTimes(stop)).filter(x => x.realTime && !x.cancelled); } catch { return 0; }
  let filled = 0;
  for (const r of need) {
    const rn = norm(name(r));
    const hit = list.find(x => {
      const sched = Date.parse(x.place?.scheduledDeparture || x.place?.scheduledArrival);
      return (norm(x.routeShortName) === rn || norm(x.displayName) === rn) && Math.abs(sched - r.sched) < 90000;
    });
    if (!hit) continue;
    const t = Date.parse(hit.place.departure || hit.place.arrival);
    if (!t) continue;
    Object.assign(r, { live: true, t, dev: Math.round((t - r.sched) / 1000), via: 'transitous' });
    filled++;
  }
  return filled;
}
