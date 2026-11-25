/* Small helpers with no app state. */
import { CFG } from './config.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
export const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const DARK_THEMES = { dark: true, forest: true }, LIGHT_THEMES = { light: true, paper: true, violet: true };
export const isDark = () => {
  const t = document.documentElement.dataset.theme;
  if (DARK_THEMES[t]) return true;
  if (LIGHT_THEMES[t]) return false;
  return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
};
export const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);

// localStorage that never throws (private mode, full disk)
export const store = {
  get(k, d) { try { const v = localStorage.getItem('lt3_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lt3_' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem('lt3_' + k); } catch { /* ignore */ } }
};

const fmtClock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CFG.tz });
export const clock = ms => fmtClock.format(new Date(ms));
export function miles(m) {
  const mi = m / 1609.34;
  return mi < 0.1 ? Math.round(m * 3.281 / 50) * 50 + ' ft' : (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
}

/* ---- geography ---- */
const RAD = Math.PI / 180;
export function dist(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}
export function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
export const angleDiff = (to, from) => ((to - from) % 360 + 540) % 360 - 180;   // shortest turn, -180..180
export const inRegion = p => p.lat > CFG.region.s && p.lat < CFG.region.n && p.lon > CFG.region.w && p.lon < CFG.region.e;
export const bounds = pts => [[Math.min(...pts.map(p => p.lon)), Math.min(...pts.map(p => p.lat))], [Math.max(...pts.map(p => p.lon)), Math.max(...pts.map(p => p.lat))]];

// Google encoded polyline, any precision (5 for OneBusAway, 7 for the trip planner). Arithmetic, so precision 7 can't overflow.
export function decodePolyline(str, prec = 5) {
  const f = 10 ** prec, out = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => { let res = 0, mul = 1, b; do { b = str.charCodeAt(i++) - 63; res += (b & 0x1f) * mul; mul *= 32; } while (b >= 0x20 && i < str.length); return res % 2 ? -(res + 1) / 2 : res / 2; };
  while (str && i < str.length) { lat += next(); lon += next(); out.push([lat / f, lon / f]); }
  return out;
}

/* A shape is a polyline with distances along it, so things can move "s metres along the track". */
export function makeShape(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }));
  return { pts, cum, len: cum[cum.length - 1] || 0 };
}
export function pointAt(sh, s) {
  const c = sh.cum;
  s = clamp(s, 0, sh.len);
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
  const f = (s - c[lo]) / (c[hi] - c[lo] || 1), a = sh.pts[lo], b = sh.pts[hi] || a;
  return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f };
}
// heading of the track around s, averaged over a short stretch so corners turn smoothly
export const headingAt = (sh, s) => bearing(pointAt(sh, s - 10), pointAt(sh, s + 18));
export function project(sh, p) {
  const kx = 111320 * Math.cos(p.lat * RAD), ky = 110540;
  let best = Infinity, bs = 0;
  for (let i = 1; i < sh.pts.length; i++) {
    const a = sh.pts[i - 1], b = sh.pts[i];
    const ax = (a[1] - p.lon) * kx, ay = (a[0] - p.lat) * ky, dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * ky;
    const l2 = dx * dx + dy * dy, t = l2 ? clamp(-(ax * dx + ay * dy) / l2, 0, 1) : 0;
    const x = ax + dx * t, y = ay + dy * t, d = x * x + y * y;
    if (d < best) { best = d; bs = sh.cum[i - 1] + (sh.cum[i] - sh.cum[i - 1]) * t; }
  }
  return { s: bs, d: Math.sqrt(best) };
}
export const lineFeature = (pts, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts.map(p => [p[1], p[0]]) } });
export const pointFeature = (p, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
export const collection = (features = []) => ({ type: 'FeatureCollection', features });
