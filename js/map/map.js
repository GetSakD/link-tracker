/* The map: MapLibre on the GPU. Trains and buses are drawn as map layers (not page elements), so
   they move in the same frame as the map when you pan or pinch — page-element markers lag a frame
   behind and feel sticky. Layers only re-upload when something moved at least half a pixel. */
import { CFG, COLORS } from '../config.js';
import { S, emit } from '../state.js';
import { stationIdx, mainShape, hasTrip } from '../line.js';
import { fleet, knownShape } from '../fleet.js';
import { selectedItinerary, isRide, legColor, legPath } from '../plan.js';
import * as icon from './icons.js';
import { $, cssVar, isDark, clamp, angleDiff, pointAt, lineFeature, pointFeature, collection, bounds } from '../util.js';

export let map = null;
let ready = false, meMarker = null, waitMarker = null, layerClick = false;

const styleUrl = () => isDark() ? CFG.styleDark : CFG.styleLight;
const TRAIN_LAYERS = ['lt-tr-ring', 'lt-tr-sel', 'lt-tr-arr', 'lt-tr', 'lt-tr-tag'];
const LINE_LAYERS = ['lt-route-case', 'lt-route', 'lt-trip', 'lt-st', 'lt-st-label', 'lt-st-label-end'];
const BUS_LAYERS = ['lt-vroute-case', 'lt-vroute', 'lt-veh-sel', 'lt-veh', 'lt-veh-lbl'];
const STOP_LAYERS = ['lt-bus-sel', 'lt-bus', 'lt-bus-label'];

/* ---------- small helpers ---------- */
function source(id, data) { const s = map.getSource(id); if (s) s.setData(data); else map.addSource(id, { type: 'geojson', data }); }
function layer(def, before) { if (!map.getLayer(def.id)) map.addLayer(def, before); }
function visible(ids, on) { ids.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); }); }
function image(name, img, opts = { pixelRatio: icon.PIXEL_RATIO }) { if (map.hasImage(name)) map.removeImage(name); map.addImage(name, img, opts); }
function clickable(id, fn) {
  map.on('click', id, e => { const f = e.features?.[0]; if (f) { layerClick = true; fn(f.properties); } });
  map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
}

/* ---------- start ---------- */
export function initMap() {
  if (!window.maplibregl || (maplibregl.supported && !maplibregl.supported())) throw new Error('no webgl');
  const L = S.line, a = stationIdx(S.from), b = stationIdx(S.to);
  map = new maplibregl.Map({
    container: 'map', style: styleUrl(), attributionControl: { compact: true },
    bounds: L && a >= 0 && b >= 0 ? bounds([L.stations[a], L.stations[b]]) : [[-122.33, 47.6], [-122.1, 47.83]], fitBoundsOptions: { padding: 40 },
    maxPitch: 65, maxZoom: 18, minZoom: 8, fadeDuration: 120,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2), renderWorldCopies: false, antialias: false
  });
  map.once('load', () => $('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  map.on('style.load', setup);
  map.on('rotate', updateCompass); map.on('pitch', updateCompass);
  map.on('pitchend', () => show3D(map.getPitch() > 8));
  map.on('dragstart', () => emit('userMoved'));
  map.on('rotatestart', e => { if (e.originalEvent) emit('userMoved'); });
  map.on('moveend', () => emit('mapMoved'));
  map.on('click', e => { if (layerClick) { layerClick = false; return; } if (!e.originalEvent?.target?.closest?.('.maplibregl-marker')) emit('mapTap'); });
  clickable('lt-tr', p => emit('trainTap', p.id));
  clickable('lt-veh', p => emit('busTap', { id: p.id, group: p.g }));
  clickable('lt-bus', p => emit('stopTap', p.id));
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => { ready = false; map.setStyle(styleUrl(), { diff: false }); });
}
export const mapReady = () => !!map && ready;

function setup() {
  tidyStyle();
  add3D();
  addLineLayers();
  addStopLayers();
  addPlanLayers();
  addBusLayers();
  addTrainLayers();
  ready = true; trainSig = ''; busSig = '';
  refreshLine(); refreshStops(); refreshPlan(); applyMode(); padding();
  emit('mapReady');
}

// a calm base map: only city names, softer minor roads, no rail or airport clutter
function tidyStyle() {
  const keep = /^(place_city|place_city_large|place_town|label_city|label_city_capital|label_town)$/;
  for (const l of map.getStyle().layers || []) {
    try {
      if ((l.type === 'symbol' && !keep.test(l.id)) || /railway|aeroway/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
      if (l.type === 'line' && /^highway_(minor|path)|^road/.test(l.id)) map.setPaintProperty(l.id, 'line-opacity', 0.55);
    } catch { /* layer without that property */ }
  }
}

/* ---------- which layers show, by mode ---------- */
export function applyMode() {
  if (!mapReady()) return;
  const buses = S.mode === 'buses', plan = !!S.plan;
  visible(LINE_LAYERS, !buses && !(plan && buses));
  visible(TRAIN_LAYERS, !buses);
  visible(STOP_LAYERS, buses && !plan && !S.track);
  visible(BUS_LAYERS, buses || plan);
  trainSig = ''; busSig = '';
}

/* ---------- the 2 Line ---------- */
function tripLine() {
  const L = S.line, sh = mainShape();
  if (!sh || !hasTrip()) return lineFeature([]);
  const sa = L.stations[stationIdx(S.from)].s, sb = L.stations[stationIdx(S.to)].s, s0 = Math.min(sa, sb), s1 = Math.max(sa, sb);
  const p0 = pointAt(sh, s0), p1 = pointAt(sh, s1);
  return lineFeature([[p0.lat, p0.lon], ...sh.pts.filter((_, i) => sh.cum[i] > s0 && sh.cum[i] < s1), [p1.lat, p1.lon]]);
}
function stationPoints() {
  const L = S.line; if (!L) return collection();
  const a = stationIdx(S.from), b = stationIdx(S.to), lo = Math.min(a, b), hi = Math.max(a, b);
  return collection(L.stations.map((st, i) => pointFeature(st, { name: st.name, end: i === a || i === b ? 1 : 0, mine: a >= 0 && i >= lo && i <= hi ? 1 : 0 })));
}
function meCircle() {
  if (!S.me) return collection();
  const r = Math.max(S.me.acc || 0, 5), k = 111320 * Math.cos(S.me.lat * Math.PI / 180), pts = [];
  for (let i = 0; i <= 48; i++) { const an = i / 48 * 2 * Math.PI; pts.push([S.me.lon + Math.cos(an) * r / k, S.me.lat + Math.sin(an) * r / 110540]); }
  return collection([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } }]);
}
function addLineLayers() {
  const line = cssVar('--line') || '#007CAD', dark = isDark(), text = dark ? '#F2F2F7' : '#1C1C1E', halo = dark ? '#000000' : '#FFFFFF', font = ['Noto Sans Regular'];
  source('lt-route', lineFeature(mainShape()?.pts || []));
  source('lt-trip', tripLine());
  source('lt-stations', stationPoints());
  source('lt-me', meCircle());
  const round = { 'line-cap': 'round', 'line-join': 'round' }, w = (a, b) => ['interpolate', ['linear'], ['zoom'], 9, a, 15, b];
  layer({ id: 'lt-me-acc', type: 'fill', source: 'lt-me', paint: { 'fill-color': '#0A84FF', 'fill-opacity': 0.12 } });
  layer({ id: 'lt-route-case', type: 'line', source: 'lt-route', layout: round, paint: { 'line-color': halo, 'line-width': w(5, 11), 'line-opacity': 0.85 } });
  layer({ id: 'lt-route', type: 'line', source: 'lt-route', layout: round, paint: { 'line-color': line, 'line-width': w(2.5, 6), 'line-opacity': 0.45 } });
  layer({ id: 'lt-trip', type: 'line', source: 'lt-trip', layout: round, paint: { 'line-color': line, 'line-width': w(4, 8) } });
  const end = (a, b) => ['case', ['==', ['get', 'end'], 1], a, b];
  layer({ id: 'lt-st', type: 'circle', source: 'lt-stations', paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, end(5, 2.5), 15, end(8, 5.5)], 'circle-color': end(line, halo),
    'circle-stroke-color': end(halo, ['case', ['==', ['get', 'mine'], 1], line, cssVar('--label3') || '#999']), 'circle-stroke-width': end(3, 2) } });
  layer({ id: 'lt-st-label', type: 'symbol', source: 'lt-stations', minzoom: 11, filter: ['==', ['get', 'end'], 0],
    layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 12, 'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-optional': true, 'symbol-sort-key': ['-', 1, ['get', 'mine']] },
    paint: { 'text-color': text, 'text-opacity': ['case', ['==', ['get', 'mine'], 1], 1, 0.6], 'text-halo-color': halo, 'text-halo-width': 1.6 } });
  layer({ id: 'lt-st-label-end', type: 'symbol', source: 'lt-stations', filter: ['==', ['get', 'end'], 1],
    layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 13.5, 'text-anchor': 'left', 'text-offset': [1, 0], 'text-allow-overlap': true },
    paint: { 'text-color': text, 'text-halo-color': halo, 'text-halo-width': 2 } });
}
export function refreshLine() {
  if (!mapReady() || !S.line) return;
  source('lt-route', lineFeature(mainShape()?.pts || []));
  source('lt-trip', tripLine());
  source('lt-stations', stationPoints());
}

/* ---------- trains ---------- */
let trainSig = '', tagText = '';
function addTrainLayers() {
  for (const k of ['live', 'other', 'nogps', 'you']) { image('tr-' + k, icon.trainBadge(k)); image('tra-' + k, icon.trainArrow(k)); }
  tagText = ''; setTag('Your train');
  source('lt-trains', collection());
  const blue = cssVar('--blue') || '#0A84FF', over = { 'icon-allow-overlap': true, 'icon-ignore-placement': true };
  layer({ id: 'lt-tr-ring', type: 'circle', source: 'lt-trains', filter: ['==', ['get', 'you'], 1], paint: { 'circle-radius': 26, 'circle-color': blue, 'circle-opacity': 0.14, 'circle-stroke-color': blue, 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.5, 'circle-pitch-alignment': 'map' } });
  layer({ id: 'lt-tr-sel', type: 'circle', source: 'lt-trains', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 17, 'circle-color': 'rgba(10,132,255,.45)' } });
  layer({ id: 'lt-tr-arr', type: 'symbol', source: 'lt-trains', layout: { 'icon-image': ['concat', 'tra-', ['get', 'k']], 'icon-rotate': ['get', 'h'], 'icon-rotation-alignment': 'map', ...over, 'symbol-sort-key': ['get', 'z'] } });
  layer({ id: 'lt-tr', type: 'symbol', source: 'lt-trains', layout: { 'icon-image': ['concat', 'tr-', ['get', 'k']], ...over, 'symbol-sort-key': ['get', 'z'], 'symbol-z-order': 'source' } });
  layer({ id: 'lt-tr-tag', type: 'symbol', source: 'lt-trains', filter: ['==', ['get', 'you'], 1], layout: { 'icon-image': 'tr-tag', 'icon-anchor': 'bottom', 'icon-offset': [0, -23], ...over } });
}
function setTag(text) { if (text !== tagText) { tagText = text; image('tr-tag', icon.tag(text)); } }

// half-pixel grid at this zoom: positions are rounded to it, so unchanged pictures aren't re-uploaded
const grid = () => 2 * 512 * 2 ** map.getZoom() / 360;

/* items: [{ id, p, kind, you, sel }] */
export function drawTrains(items, tag) {
  if (!mapReady() || S.mode !== 'trains' || S.view !== 'map') return;
  setTag(tag);
  const g = grid(), sig = items.map(x => x.id + x.kind + x.sel + Math.round(x.p.lon * g) + ',' + Math.round(x.p.lat * g) + ',' + Math.round(x.p.heading / 3)).join('|');
  if (sig === trainSig) return;
  trainSig = sig;
  const z = x => x.you ? 3 : x.sel ? 2 : x.kind === 'other' ? 0 : 1;
  map.getSource('lt-trains')?.setData(collection(items.slice().sort((a, b) => z(a) - z(b)).map(x =>
    pointFeature(x.p, { id: x.id, k: x.kind, h: Math.round(x.p.heading), you: x.you ? 1 : 0, sel: x.sel ? 1 : 0, z: z(x) }))));
}

/* ---------- buses on the map ---------- */
let busSig = '', routeSig = '';
function addBusLayers() {
  source('lt-vroute', collection());
  source('lt-veh', collection());
  const round = { 'line-cap': 'round', 'line-join': 'round' }, over = { 'icon-allow-overlap': true, 'icon-ignore-placement': true };
  layer({ id: 'lt-vroute-case', type: 'line', source: 'lt-vroute', layout: round, paint: { 'line-color': isDark() ? '#000' : '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 5, 16, 11], 'line-opacity': 0.7 } });
  layer({ id: 'lt-vroute', type: 'line', source: 'lt-vroute', layout: round, paint: { 'line-color': ['get', 'c'], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 6], 'line-opacity': 0.85 } });
  layer({ id: 'lt-veh-sel', type: 'circle', source: 'lt-veh', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 14, 17, 34], 'circle-color': '#0A84FF', 'circle-opacity': 0.16, 'circle-stroke-color': '#0A84FF', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.55, 'circle-pitch-alignment': 'map' } });
  layer({ id: 'lt-veh', type: 'symbol', source: 'lt-veh', layout: { 'icon-image': ['get', 'b'], 'icon-rotate': ['get', 'h'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
    'icon-size': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 0.42, 14, 0.7, 16, 1.05, 18, 1.7], ...over, 'symbol-sort-key': ['get', 'sel'], 'symbol-z-order': 'source' } });
  layer({ id: 'lt-veh-lbl', type: 'symbol', source: 'lt-veh', minzoom: 12, filter: ['!=', ['get', 'l'], ''], layout: { 'icon-image': ['get', 'l'], 'icon-anchor': 'bottom', 'icon-offset': [0, -16], ...over, 'symbol-sort-key': ['get', 'sel'] } });
}
function busImages(it) {
  const b = 'vb-' + it.color, l = it.label ? 'vl-' + it.color + it.text + it.label : '';
  if (!map.hasImage(b)) image(b, icon.busTop(it.color));
  if (l && !map.hasImage(l)) image(l, icon.routeLabel(it.label, it.color, it.text));
  return { b, l };
}
export function drawBuses() {
  if (!mapReady()) return;
  const g = grid(), list = [...fleet.values()].filter(b => b.cur);
  const sig = list.map(b => b.key + Math.round(b.cur.lon * g) + ',' + Math.round(b.cur.lat * g) + ',' + Math.round(b.heading / 2) + (b.it.sel ? 1 : 0)).join('|');
  if (sig !== busSig) {
    busSig = sig;
    map.getSource('lt-veh')?.setData(collection(list.sort((a, b) => (a.it.sel ? 1 : 0) - (b.it.sel ? 1 : 0)).map(b => {
      const im = busImages(b.it);
      return pointFeature(b.cur, { id: b.id, g: b.group, b: im.b, l: im.l, h: Math.round(b.heading * 10) / 10, sel: b.it.sel ? 1 : 0 });
    })));
  }
  // the road each tracked bus drives on
  const shapes = new Map();
  for (const b of list) if (b.group === 'track' && b.it.shapeId && knownShape(b.it.shapeId)) shapes.set(b.it.shapeId, b.it.color);
  const rs = [...shapes.keys()].join();
  if (rs !== routeSig) { routeSig = rs; map.getSource('lt-vroute')?.setData(collection([...shapes].map(([id, c]) => lineFeature(knownShape(id).pts, { c })))); }
}

/* ---------- bus stops ---------- */
function addStopLayers() {
  image('lt-bus-ico', icon.stopSign());
  source('lt-bus', collection());
  const dark = isDark();
  layer({ id: 'lt-bus-sel', type: 'circle', source: 'lt-bus', filter: ['==', ['get', 'sel'], 1], paint: { 'circle-radius': 20, 'circle-color': COLORS.bus, 'circle-opacity': 0.25 } });
  layer({ id: 'lt-bus', type: 'symbol', source: 'lt-bus', layout: { 'icon-image': 'lt-bus-ico', 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.62, 17, 1, 18, 1.15], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'sel'] } });
  layer({ id: 'lt-bus-label', type: 'symbol', source: 'lt-bus', minzoom: 16.3,
    layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 1.3], 'text-optional': true, 'text-max-width': 9 },
    paint: { 'text-color': dark ? '#F2F2F7' : '#1C1C1E', 'text-halo-color': dark ? '#000' : '#fff', 'text-halo-width': 1.5 } });
}
export function refreshStops() {
  if (mapReady()) source('lt-bus', collection(Object.values(S.stops).map(s => pointFeature(s, { id: s.id, name: s.name, sel: s.id === S.stop ? 1 : 0 }))));
}

/* ---------- directions ---------- */
function addPlanLayers() {
  source('lt-plan', collection()); source('lt-plan-pts', collection());
  const halo = isDark() ? '#000000' : '#FFFFFF', round = { 'line-cap': 'round', 'line-join': 'round' }, end = (a, b) => ['case', ['==', ['get', 'end'], 1], a, b];
  layer({ id: 'lt-plan-case', type: 'line', source: 'lt-plan', filter: ['==', ['get', 'walk'], 0], layout: round, paint: { 'line-color': halo, 'line-width': 10 } });
  layer({ id: 'lt-plan-line', type: 'line', source: 'lt-plan', filter: ['==', ['get', 'walk'], 0], layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': 6 } });
  layer({ id: 'lt-plan-walk', type: 'line', source: 'lt-plan', filter: ['==', ['get', 'walk'], 1], layout: round, paint: { 'line-color': '#0A84FF', 'line-width': 5, 'line-dasharray': [0.1, 1.8] } });
  layer({ id: 'lt-plan-pts', type: 'circle', source: 'lt-plan-pts', paint: { 'circle-radius': end(8, 6), 'circle-color': end(COLORS.red, halo), 'circle-stroke-color': end(halo, ['get', 'color']), 'circle-stroke-width': 3 } });
}
function planShapes() {
  const it = selectedItinerary(), lines = [], pts = [];
  if (!it) return { lines, pts };
  for (const l of it.legs) {
    const g = legPath(l);
    if (g.length > 1) lines.push(lineFeature(g, { walk: isRide(l) ? 0 : 1, color: legColor(l) }));
    if (isRide(l)) [l.from, l.to].forEach(p => p && pts.push(pointFeature(p, { color: legColor(l) })));
  }
  const last = it.legs.at(-1).to;
  if (last) pts.push(pointFeature(last, { color: COLORS.red, end: 1 }));
  return { lines, pts };
}
export function refreshPlan(fit) {
  document.body.classList.toggle('plan-on', !!S.plan);
  if (!mapReady()) return;
  const { lines, pts } = planShapes();
  source('lt-plan', collection(lines)); source('lt-plan-pts', collection(pts));
  applyMode();
  const coords = lines.flatMap(f => f.geometry.coordinates);
  if (fit && coords.length) fitTo(coords.map(c => ({ lon: c[0], lat: c[1] })), 16);
}
export function setWaitPin(at) {
  if (!map) return;
  if (!at) { waitMarker?.remove(); waitMarker = null; return; }
  if (!waitMarker) {
    const el = document.createElement('div');
    el.className = 'waitmk'; el.innerHTML = '<span>' + '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M6 3h12a3 3 0 0 1 3 3v10a2 2 0 0 1-1 1.7V20a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H7v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2.3A2 2 0 0 1 3 16V6a3 3 0 0 1 3-3zm0 3v5h12V6H6z"/></svg></span>Wait here';
    waitMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([at.lon, at.lat]).addTo(map);
  } else waitMarker.setLngLat([at.lon, at.lat]);
}

/* ---------- you ---------- */
export function drawMe() {
  if (!map || !S.me) return;
  if (!meMarker) {
    const el = document.createElement('div'); el.className = 'me'; el.setAttribute('aria-label', 'Your location');
    meMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([S.me.lon, S.me.lat]).addTo(map);
  } else meMarker.setLngLat([S.me.lon, S.me.lat]);
  if (mapReady()) source('lt-me', meCircle());
}

/* ---------- camera ---------- */
const topInset = () => ($('.top')?.getBoundingClientRect().bottom || 62) + 8;
let panel = () => [0, false];                 // [height of the panel covering the map, side layout?]
export function setPanelSource(fn) { panel = fn; }
export function padding() {
  if (!map) return;
  const [sheetHeight, side] = panel();
  const want = side ? { top: topInset(), bottom: 12, left: CFG.sideWidth + 24, right: 64 } : { top: topInset(), bottom: sheetHeight + 12, left: 12, right: 64 };
  const cur = map.getPadding();
  if (['top', 'bottom', 'left', 'right'].every(k => Math.abs(cur[k] - want[k]) < 1)) return;   // unchanged: don't interrupt a camera move
  map.setPadding(want);
}
export function fitTo(points, maxZoom = 14.5) {
  if (!map || !points.length) return;
  padding();
  map.fitBounds(bounds(points), { padding: { top: 30, bottom: 30, left: 36, right: 30 }, maxZoom, pitch: 0, bearing: 0, duration: 900 });
}
export function fitTrip(extra = []) {
  if (!map || !hasTrip()) return;
  fitTo([S.line.stations[stationIdx(S.from)], S.line.stations[stationIdx(S.to)], ...extra]);
}
export function flyTo(p, zoom, duration = 600) { if (map && p) map.easeTo({ center: [p.lon, p.lat], zoom: zoom ?? map.getZoom(), duration }); }
export const center = () => map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : null;
export const zoom = () => map ? map.getZoom() : 0;
export const viewBounds = () => { const b = map.getBounds(); return { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() }; };

/* Following: one camera controller for every kind of follow.
   'track' keeps the map flat and simply stays on the vehicle; 'drive' flies in, tilts into 3D and
   turns with the vehicle like a navigation app. The fly-in is blended per frame toward the *moving*
   vehicle, so it lands on it instead of where it was when you tapped. */
let follow = null;
export function startFollow(getTarget, style = 'track') {
  if (!map) return;
  map.stop();
  follow = { get: getTarget, style, t0: performance.now(), from: { c: map.getCenter(), z: map.getZoom(), p: map.getPitch(), b: map.getBearing() } };
  if (style === 'drive') show3D(true);
}
export function stopFollow(flatten) { follow = null; if (flatten) flat(); }
export const following = () => !!follow;
export function stepCamera(t, dt) {
  if (!follow || !map) return false;
  const v = follow.get(); if (!v) return true;
  const drive = follow.style === 'drive', F = follow.from;
  const k = clamp((t - follow.t0) / 1400, 0, 1), e = 1 - (1 - k) ** 3;
  const wantZ = drive ? CFG.follow.zoom : Math.max(F.z, 14), wantP = drive ? CFG.follow.pitch : F.p;
  if (k < 1) {
    map.jumpTo({ center: [F.c.lng + (v.lon - F.c.lng) * e, F.c.lat + (v.lat - F.c.lat) * e], zoom: F.z + (wantZ - F.z) * e, pitch: F.p + (wantP - F.p) * e,
      bearing: drive && v.heading != null ? F.b + angleDiff(v.heading, F.b) * e : F.b });
    return true;
  }
  const c = map.getCenter(), g = grid() / 2;
  const off = (Math.abs(c.lng - v.lon) + Math.abs(c.lat - v.lat)) * g;
  const turn = drive && v.heading != null ? angleDiff(v.heading, map.getBearing()) : 0;
  if (off > 0.3 || Math.abs(turn) > 0.2) map.jumpTo({ center: [v.lon, v.lat], bearing: map.getBearing() + turn * Math.min(1, dt / 1100) });
  return true;
}
export function flat() { if (map && (map.getPitch() > 1 || Math.abs(map.getBearing()) > 1)) map.easeTo({ pitch: 0, bearing: 0, duration: 800 }); show3D(false); }

/* ---------- 3D buildings + compass ---------- */
function add3D() {
  const st = map.getStyle();
  if (!st?.sources?.openmaptiles || map.getLayer('lt-3d')) return;
  layer({ id: 'lt-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 15, layout: { visibility: map.getPitch() > 8 ? 'visible' : 'none' },
    paint: { 'fill-extrusion-color': isDark() ? '#2A2D33' : '#E3E5EA', 'fill-extrusion-opacity': 0.85, 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0] } });
}
function show3D(on) { if (mapReady()) visible(['lt-3d'], on); }
function updateCompass() {
  const b = $('#btnCompass'); if (!b) return;
  b.classList.toggle('off', !(map.getPitch() > 3 || Math.abs(map.getBearing()) > 3));
  b.firstChild.style.transform = `rotateX(${Math.round(map.getPitch() * 0.6)}deg) rotate(${-map.getBearing()}deg)`;
}
