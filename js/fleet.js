/* Buses on the map. Three features put buses on screen (a stop's next buses, a bus you search for,
   the bus on your planned trip); they all hand their list here and one motion model drives them all.

   Road-following motion (what Waze, Uber and Google do): each bus is snapped to its route's road
   shape, keeps rolling at its measured speed between GPS fixes (dead reckoning), turns with the road
   instead of cutting corners, and new fixes are blended in rather than jumped to. */
import { S, now } from './state.js';
import { oba } from './api.js';
import { Follower, Glide } from './motion.js';
import { wake } from './loop.js';
import { clamp, project, pointAt, headingAt, decodePolyline, makeShape, dist, bearing } from './util.js';

export const fleet = new Map();          // key "group|id" -> bus
const shapes = {};                       // shapeId -> shape | null (loading/failed)

export async function busShape(id) {
  if (!id) return null;
  if (shapes[id] !== undefined) return shapes[id];
  shapes[id] = null;
  try { const d = await oba('shape/' + encodeURIComponent(id)); const pts = decodePolyline(d.entry?.points); if (pts.length > 1) shapes[id] = makeShape(pts); }
  catch { /* glides in a straight line instead */ }
  return shapes[id];
}
export const knownShape = id => shapes[id] || null;

/* items: { id, lat, lon, bearing, at, shapeId, color, text, label, sel } */
export function setGroup(group, items) {
  const t = performance.now(), keep = new Set();
  for (const it of items) {
    const key = group + '|' + it.id; keep.add(key);
    let b = fleet.get(key);
    if (!b) { b = { key, group, id: it.id, glide: new Glide({ lat: it.lat, lon: it.lon }, it.bearing ?? 0), f: new Follower({ backTolerance: 400, maxSpeed: 28, catchUp: 8, accel: 1500 }) }; fleet.set(key, b); }
    else if (b.it && (b.it.lat !== it.lat || b.it.lon !== it.lon)) {
      const moved = dist(b.glide.cur, it);
      b.glide.set({ lat: it.lat, lon: it.lon }, moved > 12 ? bearing(b.glide.cur, it) : it.bearing, t);
    }
    b.it = it;
    roadFix(b, it);
  }
  for (const [k, b] of fleet) if (b.group === group && !keep.has(k)) fleet.delete(k);
  wake();
}

// a GPS fix on the road shape: speed comes from the last two fixes
function roadFix(b, it) {
  const sh = it.shapeId ? shapes[it.shapeId] : null;
  if (!sh) { b.road = null; if (it.shapeId) busShape(it.shapeId).then(s => { if (s && b.it === it) roadFix(b, it); }); return; }
  const pr = project(sh, it);
  if (pr.d > 90) { b.road = null; return; }
  const at = it.at || now();
  if (!b.road || b.road.sh !== sh) { b.road = { sh, s: pr.s, at, speed: 0 }; b.f.reset(pr.s); return; }
  if (at <= b.road.at + 500) return;                          // same fix as before
  const spd = clamp((pr.s - b.road.s) / ((at - b.road.at) / 1000), 0, 24);
  b.road.speed = b.road.speed ? b.road.speed * 0.35 + spd * 0.65 : spd;
  b.road.s = pr.s; b.road.at = at;
}

/* every frame: returns true while any bus is moving */
export function stepFleet(t, dt) {
  let busy = false;
  for (const b of fleet.values()) {
    if (b.road) {
      const r = b.road, target = clamp(r.s + r.speed * clamp((now() - r.at) / 1000, 0, 60), 0, r.sh.len);
      const s = clamp(b.f.step(target, r.speed, dt), 0, r.sh.len);
      b.cur = pointAt(r.sh, s);
      b.heading = b.f.turn(headingAt(r.sh, s), dt);
      busy = true;
    } else {
      if (b.glide.step(t)) busy = true;
      b.cur = b.glide.cur; b.heading = b.glide.heading;
      b.f.heading = b.heading;
    }
  }
  return busy;
}

export const groupBuses = group => [...fleet.values()].filter(b => b.group === group);
