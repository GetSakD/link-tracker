/* OneBusAway Puget Sound: Sound Transit, King County Metro, Community Transit and friends.
   One request queue (the shared TEST key is rate limited), retries, and the parsers every feature shares. */
import { CFG } from './config.js';
import { S, now } from './state.js';
import { sleep } from './util.js';

let transport = null, netFails = 0, lastCall = 0, queue = Promise.resolve(), cb = 0;
// after a spell offline the app falls back to JSONP; once back online, try normal requests again
const resetTransport = () => { if (transport === 'jsonp') { transport = null; netFails = 0; } };
window.addEventListener('online', resetTransport);
setInterval(resetTransport, 5 * 60000);

function jsonp(url, ms) {
  return new Promise((resolve, reject) => {
    const name = '__oba' + (++cb), u = new URL(url), s = document.createElement('script');
    u.searchParams.set('callback', name);
    const done = () => { clearTimeout(timer); window[name] = () => {}; s.remove(); };   // a late reply lands in a no-op
    const timer = setTimeout(() => { done(); reject(new Error('Request timed out')); }, ms);
    window[name] = d => { done(); resolve(d); };
    s.onerror = () => { done(); reject(new Error('Network error')); };
    s.src = u.toString(); document.head.appendChild(s);
  });
}

async function get(u) {
  if (transport === 'jsonp') return jsonp(u, 15000);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(u, { signal: ctl.signal });
    const txt = await r.text();
    try { const j = JSON.parse(txt); transport = 'fetch'; return j; }
    catch { if (r.status === 429) return { code: 429 }; throw new Error('Unexpected response (' + r.status + ')'); }
  } catch (e) {
    // CORS blocked or offline: after two network failures in a row, switch to JSONP for good
    if (transport === null && e.name === 'TypeError') { if (++netFails >= 2) transport = 'jsonp'; return jsonp(u, 15000); }
    throw e;
  } finally { clearTimeout(t); }
}

// calls leave at least `gap` ms apart, even when many start at once
function slot() {
  const gap = S.key === 'TEST' ? 650 : 150;
  const p = queue.then(() => { const w = lastCall + gap - Date.now(); return w > 0 ? sleep(w) : null; }).then(() => { lastCall = Date.now(); });
  queue = p.catch(() => {});
  return p;
}

function fail(msg, extra) { return Object.assign(new Error(msg), extra); }

export async function oba(path, params = {}) {
  const q = path.indexOf('?'), base = q >= 0 ? path.slice(0, q) : path;
  if (!base.endsWith('.json')) path = base + '.json' + (q >= 0 ? path.slice(q) : '');    // otherwise the server answers in XML
  const u = new URL(CFG.base + path);
  u.searchParams.set('key', S.key);
  for (const k in params) u.searchParams.set(k, params[k]);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await slot();
      const body = await get(u);
      if (body) netFails = 0;
      if (body?.currentTime > 1e12) S.clockOffset = body.currentTime - Date.now();
      const code = body?.code;
      if (code === 200) { S.okCalls++; S.keyBad = false; S.busyAt = 0; noteRefs(body.data?.references); return body.data || {}; }
      if (code === 429) { S.busyAt = Date.now(); lastErr = fail('Sound Transit is busy (rate limit). Retrying…', { busy: true }); await sleep(1500 * (attempt + 1)); continue; }
      if (code === 401) { S.keyBad = true; throw fail('The API key was rejected. Check it in Settings.', { fatal: true }); }
      if (code === 404) throw fail('Not found: ' + path, { fatal: true, notFound: true });
      throw fail(body?.text || 'Error ' + code);
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e; await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr || fail('Could not reach Sound Transit');
}

export function indexRefs(refs = {}) {
  const by = list => Object.fromEntries((list || []).map(x => [x.id, x]));
  return { trips: by(refs.trips), stops: by(refs.stops), routes: by(refs.routes), situations: refs.situations || [] };
}
function noteRefs(refs) {
  (refs?.routes || []).forEach(r => { S.routes[r.id] = r; });
  (refs?.stops || []).forEach(s => { S.stopInfo[s.id] = { name: s.name, lat: s.lat, lon: s.lon }; });
}

/* ---- shared parsers ---- */

// OneBusAway orientation: degrees, 0 = east, counter-clockwise → compass bearing
export function obaBearing(ts) {
  const o = ts?.orientation;
  return typeof o === 'number' && !isNaN(o) ? ((90 - o) % 360 + 360) % 360 : null;
}

// one row of arrivals-and-departures, the same shape for trains, buses and planned trips
export function parseDeparture(x, refs) {
  const ts = x.tripStatus || {}, tr = refs?.trips[x.tripId] || {};
  const sched = x.scheduledDepartureTime || x.scheduledArrivalTime;
  let live = x.predicted === true && ((x.predictedDepartureTime || 0) > 0 || (x.predictedArrivalTime || 0) > 0);
  let pred = live ? (x.predictedDepartureTime || x.predictedArrivalTime) : 0;
  // The vehicle is already on this trip and reporting, but the feed left out a predicted time
  // (common while a bus waits at the first stop): its live delay still tells us when it will come.
  if (!live && ts.predicted && ts.activeTripId === x.tripId && typeof ts.scheduleDeviation === 'number') {
    live = true; pred = sched + ts.scheduleDeviation * 1000;
  }
  return {
    tripId: x.tripId, routeId: x.routeId, t: pred || sched, sched, live,
    dev: live ? Math.round((pred - sched) / 1000) : 0,
    headsign: x.tripHeadsign || tr.tripHeadsign || '', dirId: tr.directionId != null ? String(tr.directionId) : null,
    vehicleId: ts.vehicleId || x.vehicleId || '',
    // a real vehicle sends GPS; King County also lists timetable placeholders with no GPS and 7-digit ids
    gps: realGps(ts), gpsAt: ts.lastLocationUpdateTime || 0,
    // the vehicle is reporting, but on the trip before this one
    blockLive: !!(ts.predicted && ts.activeTripId && ts.activeTripId !== x.tripId),
    stopsAway: typeof x.numberOfStopsAway === 'number' ? x.numberOfStopsAway : null,
    distFromStop: typeof x.distanceFromStop === 'number' ? x.distanceFromStop : null,
    pos: ts.position && (live || ts.predicted) ? { lat: ts.position.lat, lon: ts.position.lon } : null,
    bearing: obaBearing(ts),
    near: S.stopInfo[ts.closestStop]?.name || S.stopInfo[ts.nextStop]?.name || '',
    dup: /DUPLICATED/i.test(ts.status || ''),
    canceled: /cancel/i.test((ts.status || '') + ' ' + (x.status || '')),
    departs: x.departureEnabled !== false
  };
}
export const realGps = ts => !!(ts && ((ts.lastLocationUpdateTime || 0) > 0 || ts.lastKnownLocation?.lat));

// the feed says this vehicle has already gone past the stop
export const passedStop = x => (x.stopsAway != null && x.stopsAway < 0) || (x.distFromStop != null && x.distFromStop < -60 && x.live);

export async function departures(stopId, minutesAfter, minutesBefore = 1) {
  const r = await oba('arrivals-and-departures-for-stop/' + encodeURIComponent(stopId), { minutesBefore, minutesAfter });
  const refs = indexRefs(r.references);
  // one row per trip: a placeholder sometimes repeats a trip a real bus is already running
  const best = new Map();
  for (const x of (r.entry?.arrivalsAndDepartures || []).map(x => parseDeparture(x, refs))) {
    const o = best.get(x.tripId), score = y => (y.gps ? 2 : 0) + (y.live ? 1 : 0);
    if (!o || score(x) > score(o)) best.set(x.tripId, x);
  }
  return { refs, rows: [...best.values()].filter(x => !passedStop(x)) };
}

// a vehicle from a trip status (trips-for-route, trip-for-vehicle)
export function vehicleFrom(tripId, st, refs) {
  if (!st?.position || !st.predicted) return null;
  // no GPS at all (a timetable placeholder), or GPS too old to trust: not a bus we can show
  if (!realGps(st)) return null;
  if (st.lastLocationUpdateTime && Date.now() + (S.clockOffset || 0) - st.lastLocationUpdateTime > 5 * 60000) return null;
  const tr = refs?.trips[tripId] || refs?.trips[st.activeTripId] || {};
  const gps = st.lastKnownLocation?.lat ? st.lastKnownLocation : st.position;
  return {
    tripId: st.activeTripId || tripId, vehicleId: st.vehicleId || '', routeId: tr.routeId || '', headsign: tr.tripHeadsign || '', shapeId: tr.shapeId || '',
    pos: { lat: gps.lat, lon: gps.lon }, bearing: obaBearing(st), dev: Math.round(st.scheduleDeviation || 0),
    next: st.nextStop || '', near: st.closestStop || '', at: st.lastLocationUpdateTime || st.lastUpdateTime || now()
  };
}

// fleet numbers are 3-5 digits; longer ids are the feed's internal placeholders, not a number on the bus
export const busNumber = vid => { const n = String(vid || '').replace(/^\d+_/, ''); return /^\d{1,5}$/.test(n) ? n : ''; };
export const routeName = r => r ? (r.shortName || r.nullSafeShortName || r.longName || '') : '';
export const routeColor = r => r?.color ? '#' + String(r.color).replace('#', '') : '#1A8597';
export const routeText = r => r?.textColor ? '#' + String(r.textColor).replace('#', '') : '#FFFFFF';
export const byRouteName = (a, b) => routeName(S.routes[a]).localeCompare(routeName(S.routes[b]), 'en', { numeric: true });

// the feed's text sometimes arrives double-encoded ("â€™" for "'")
export function fixText(s) {
  s = String(s || '');
  if (!/[ÂÃâ]/.test(s)) return s;
  try { return decodeURIComponent(escape(s)); }
  catch { return s.replace(/â€™|â€˜/g, "'").replace(/â€œ|â€\u009d/g, '"').replace(/â€"/g, '–').replace(/Â/g, ''); }
}
