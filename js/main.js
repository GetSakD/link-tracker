/* Link Tracker — live 2 Line trains and Puget Sound buses.
   Data flows one way: refresh() pulls from the feeds into S → changed() → render() draws the panel,
   and one animation loop moves trains, buses and the camera every frame. */
import { CFG } from './config.js';
import { S, now, on, emit, changed } from './state.js';
import { addTask, wake } from './loop.js';
import { initAppearance } from './ui/theme.js';
import { oba } from './api.js';
import { loadLine, restoreLine, stationIdx, hasTrip, nearestStation, tripUp, isUp } from './line.js';
import { refreshTrains, loadDepartures, placeTrain, yourTrain, nextTrain, saveSnapshot, loadSnapshot } from './trains.js';
import { stopsAround, stopsInView, loadStopDepartures, showStopBuses, findBus, refreshTrackedBus, showTrackedBuses, stopTracking, trackedBus } from './buses.js';
import { plan, trackPlanRides, showPlanBuses, firstRide } from './plan.js';
import { fleet, stepFleet } from './fleet.js';
import * as M from './map/map.js';
import { initSheet, setDetent, visibleHeight, isSide } from './ui/sheet.js';
import { trainsView, busesView, planView } from './ui/views.js';
import { buildDiagram, drawLine } from './ui/lineview.js';
import { morph } from './ui/dom.js';
import { tick } from './ui/parts.js';
import { initPanels, openPicker, closePicker, renderPicker, pickStation, skipPicker, pickerOpen, openSettings, closePanel, toast, updateStatus } from './ui/panels.js';
import { initDirections, openDirections, D } from './ui/directions.js';
import { $, $$, store } from './util.js';

const body = $('#sheetBody');

/* ================= render: state → panel ================= */
function render() {
  if (document.activeElement?.id === 'findInput') return;          // don't redraw under someone typing
  morph(body, S.plan ? planView() : S.mode === 'buses' ? busesView() : trainsView());
  tick(); updateStatus();
  const ride = firstRide();
  M.setWaitPin(S.plan && ride && Date.parse(ride.startTime) > now() - 60000 ? (ride.stop || ride.from) : null);
}
on('render', render);
on('render', wake);          // new data can mean new things to animate

/* ================= refresh: feeds → state ================= */
let busy = false, again = false, lastRefresh = 0;
async function refresh(manual) {
  if (busy) { again = true; return; }
  busy = true; lastRefresh = Date.now();
  const before = S.okCalls;
  const ok = (quiet) => { if (S.okCalls > before) { S.lastOk = now(); S.err = null; } else if (!quiet) S.err = S.keyBad ? 'The API key was rejected. Check it in Settings.' : S.err || 'No answer from Sound Transit'; };
  try {
    if (S.plan?.its) { await trackPlanRides(); ok(!S.plan?.its?.some(it => it.legs.some(l => l.mode !== 'WALK'))); return; }
    if (S.mode === 'buses') {
      if (S.track) await refreshTrackedBus(); else if (S.stop) await loadStopDepartures();
      ok(!S.track && !S.stop); return;
    }
    const fresh = S.line ? null : await loadLine(false);
    if (S.line && !hasTrip()) {
      if (!S.pickDismissed && !pickerOpen()) openPicker(stationIdx(S.from) < 0 ? 'from' : 'to', true);
    }
    M.refreshLine();
    await refreshTrains(fresh);
    if (hasTrip()) await loadDepartures(changed);
    ok(); saveSnapshot();
    if (!refresh.framed && hasTrip()) { refresh.framed = true; M.fitTrip(); }
  } catch (e) {
    S.err = e?.message || String(e);
    if (manual || !S.lastOk) toast(S.err);
    if (e?.notFound) { store.del('line'); S.line = null; }
  } finally {
    busy = false;
    changed();
    if (S.view === 'line') buildDiagram();
    if (again) { again = false; setTimeout(() => refresh(false), 50); }
  }
}
const kick = () => refresh(true);
setInterval(() => {
  tick(); updateStatus();
  if (document.visibilityState !== 'hidden' && Date.now() - lastRefresh >= S.refreshSec * 1000) refresh(false);
}, 1000);

/* ================= animation: one loop for everything that moves ================= */
addTask((t, dt) => {
  const T = now(), y = yourTrain(), up = tripUp(), items = [];
  for (const k in S.trains) {
    const v = S.trains[k], p = placeTrain(v, T, dt);
    if (!p) continue;
    v.cur = p;
    items.push({ id: k, p, you: k === y?.v.tripId, sel: S.selected === k,
      kind: k === y?.v.tripId ? 'you' : !v.predicted ? 'nogps' : isUp(v.dirId) === up ? 'live' : 'other' });
  }
  const n = nextTrain(), m = n ? Math.round((n.t - now()) / 60000) : null;
  M.drawTrains(items, n ? 'Your train · ' + (m <= 0 ? 'now' : m + ' min') : 'Your train');
  if (S.view === 'line') drawLine(t, y?.v.tripId, id => { if (!S.noMap) setView('map'); selectTrain(id); });
  return items.length > 0 && (S.mode === 'trains' || S.view === 'line');
});
addTask((t, dt) => { const moving = stepFleet(t, dt); M.drawBuses(); return moving; });
addTask((t, dt) => M.stepCamera(t, dt));

/* ================= following ================= */
const followTrain = () => { const v = S.selected ? S.trains[S.selected] : yourTrain()?.v; return v?.cur ? { ...v.cur, heading: null } : null; };
const followBus = () => { const b = fleet.get('track|' + S.track?.sel); return b?.cur ? { ...b.cur, heading: b.heading } : null; };
const followPlan = () => { const b = [...fleet.values()].find(x => x.group === 'plan'); return b?.cur ? { ...b.cur, heading: b.heading } : null; };
function setFollow(kind) {
  S.follow = kind === 'train' || kind === 'plan';
  if (S.track) S.track.follow = kind === 'bus';
  if (!kind) M.stopFollow(true);
  else {
    if (!isSide() && S.detent !== 'peek') setDetent(kind === 'train' ? 'mid' : 'peek');
    M.startFollow(kind === 'train' ? followTrain : kind === 'bus' ? followBus : followPlan, kind === 'train' ? 'track' : 'drive');
  }
  wake(); changed();
}
on('userMoved', () => { if (M.following()) { S.follow = false; if (S.track) S.track.follow = false; M.stopFollow(false); changed(); } });

/* ================= what you can do ================= */
function selectTrain(id) {
  S.selected = id; S.follow = false; M.stopFollow(false);
  if (S.detent === 'peek') setDetent('mid');
  M.flyTo(S.trains[id]?.cur);
  changed();
}
function setView(view) {
  S.view = view;
  const lv = $('#lineView'), onLine = view === 'line';
  lv.classList.toggle('off', !onLine); lv.setAttribute('aria-hidden', String(!onLine));
  $('#btnLine').setAttribute('aria-pressed', String(onLine));
  $('#sheet').style.visibility = onLine && !S.noMap ? 'hidden' : '';      // without a map the departures stay on screen
  document.body.classList.toggle('line-on', onLine);
  if (onLine) buildDiagram();
  wake();
}
function setMode(m) {
  if (m === S.mode) return;
  S.mode = m; store.set('mode', m);
  document.body.classList.toggle('mode-bus', m === 'buses');
  $$('.modeseg button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  if (m === 'buses' && S.view === 'line') setView('map');
  S.selected = null; setFollow(null);
  if (m !== 'buses') { stopTracking(); S.stop = null; S.stopArr = null; M.refreshStops(); }
  showStopBuses();
  M.applyMode();
  if (m === 'buses') {
    if (S.me) stopsAround(S.me.lat, S.me.lon, 700).then(() => { M.refreshStops(); changed(); }, () => {});
    if (M.map && M.zoom() < CFG.busZoom) M.flyTo(S.me || M.center(), 15.5, 700); else loadStopsInView();
  } else { $('#hint').classList.add('hidden'); M.fitTrip(); }
  changed(); wake(); kick();
}
function selectStop(id) {
  if (!S.stops[id]) return;
  S.stop = id; S.stopArr = null; S.routeFilter = 'all';
  M.refreshStops();
  if (S.detent === 'peek') setDetent('mid');
  M.flyTo(S.stops[id], Math.max(M.zoom(), 15.5));
  changed();
  loadStopDepartures().then(changed, e => toast(e.message));
}
function closeStop() { S.stop = null; S.stopArr = null; M.refreshStops(); showStopBuses(); changed(); }
let stopTimer = 0;
function loadStopsInView() {
  clearTimeout(stopTimer);
  stopTimer = setTimeout(async () => {
    if (!M.mapReady() || S.mode !== 'buses') return;
    $('#hint').classList.toggle('hidden', M.zoom() >= CFG.busZoom || !!S.track || !!S.plan);
    if (S.track || M.zoom() < CFG.busZoom) return;
    try { await stopsInView(M.viewBounds(), M.center(), () => M.refreshStops()); } catch (e) { toast(e.message); }
    if (!S.stop) changed();
  }, 400);
}
async function startFind(q) {
  if (S.detent === 'peek') setDetent('mid');
  const p = findBus(q, S.me || M.center() || CFG.north);
  M.applyMode(); changed();
  await p;
  M.applyMode();
  const sel = trackedBus();
  if (sel) setFollow('bus');
  else if (S.track?.vehicles.length) M.fitTo([...S.track.vehicles.map(v => v.pos), ...(S.me ? [S.me] : [])], 15);
  changed();
}
function endFind() { stopTracking(); setFollow(null); M.applyMode(); showStopBuses(); changed(); }
function tripChanged() {
  S.arr = null; S.selected = null; S.follow = false;
  M.refreshLine(); changed();
  if (S.view === 'line') buildDiagram();
  M.fitTrip(); kick();
}
on('tripChanged', tripChanged);

async function runPlan({ from, to, mode }) {
  S.selected = null; setFollow(null);
  const base = { mode, from: from.name, to: to.name, req: { from, to } };
  S.plan = { ...base, loading: true };
  setDetent('mid'); changed();
  try { const its = await plan(from, to, mode); S.plan = { ...base, its, sel: its.length ? 0 : null }; }
  catch (e) { S.plan = { ...base, its: [], err: e.message || "The trip planner isn't available right now." }; }
  M.refreshPlan(true); changed();
  trackPlanRides().then(changed);
}
on('plan', runPlan);
function clearPlan() { S.plan = null; setFollow(null); showPlanBuses(); M.refreshPlan(); M.applyMode(); changed(); }

/* ================= your location ================= */
let watch = null, wasWatching = false;
function locate(fly) {
  if (!('geolocation' in navigator)) { toast("Location isn't available on this device."); return; }
  if (watch != null) { if (fly && S.me) M.flyTo(S.me, Math.max(M.zoom(), 14), 700); return; }
  let first = true;
  watch = navigator.geolocation.watchPosition(p => {
    S.me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    store.set('locOk', true);
    M.drawMe(); $('#btnLocate').setAttribute('aria-pressed', 'true');
    renderPicker();
    if (first) {
      if (fly) M.flyTo(S.me, Math.max(M.zoom(), S.mode === 'buses' ? 15.5 : 14), 800);
      if (S.mode === 'buses') stopsAround(S.me.lat, S.me.lon, 700).then(() => { M.refreshStops(); changed(); }, () => {});
      if (fly === 'near') { const i = nearestStation(S.me); if (i >= 0) pickStation(S.line.stations[i].name); }
    }
    first = false; changed();
  }, err => {
    watch = null; $('#btnLocate').setAttribute('aria-pressed', 'false');
    toast(err.code === 1 ? 'Location is off for this site. Turn it on in Settings › Privacy › Location Services › Safari Websites.' : "Couldn't get your location right now.");
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
on('needLocation', () => locate(false));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { kick(); if (wasWatching && watch == null) { wasWatching = false; locate(false); } }
  else if (watch != null) { navigator.geolocation.clearWatch(watch); watch = null; wasWatching = true; }   // save battery
});

/* ================= wiring ================= */
const ACTIONS = {
  'pick-from': () => openPicker('from'),
  'pick-to': () => openPicker('to'),
  swap: () => { [S.from, S.to] = [S.to, S.from]; store.set('from', S.from); store.set('to', S.to); tripChanged(); },
  follow: () => setFollow(S.follow ? null : 'train'),
  close: () => { S.selected = null; setFollow(null); },
  'stop-close': closeStop,
  locate: () => locate(true),
  dirs: openDirections,
  'track-close': endFind,
  'track-all': () => { S.track.sel = null; setFollow(null); showTrackedBuses(); M.fitTo(S.track.vehicles.map(v => v.pos), 15); changed(); },
  'track-follow': () => setFollow(S.track.follow ? null : 'bus'),
  'plan-close': clearPlan,
  'plan-mode': b => { if (S.plan?.req && S.plan.mode !== b.dataset.m) { D.mode = b.dataset.m; runPlan({ ...S.plan.req, mode: D.mode }); } },
  'plan-follow': () => setFollow(S.follow ? null : 'plan'),
  'plan-edit': openDirections
};
function wire() {
  initAppearance();
  body.addEventListener('click', e => {
    const it = e.target.closest('[data-it]');
    if (it && S.plan) { S.plan.sel = Number(it.dataset.it); M.refreshPlan(true); showPlanBuses(); changed(); trackPlanRides().then(changed); return; }
    const st = e.target.closest('[data-stop]'); if (st) return selectStop(st.dataset.stop);
    const vh = e.target.closest('[data-veh]'); if (vh && S.track) { S.track.sel = vh.dataset.veh; showTrackedBuses(); setFollow('bus'); return; }
    const rt = e.target.closest('[data-route]'); if (rt) { S.routeFilter = rt.dataset.route; showStopBuses(); changed(); return; }
    const b = e.target.closest('[data-act]'); if (b) ACTIONS[b.dataset.act]?.(b);
  });
  body.addEventListener('toggle', e => { if (e.target.matches?.('details.alert')) S.alertOpen = e.target.open; }, true);
  body.addEventListener('submit', e => {
    if (e.target.id !== 'findForm') return;
    e.preventDefault(); const inp = $('#findInput'), q = inp.value; inp.blur(); startFind(q);
  });
  $$('.modeseg button').forEach((b, i, all) => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
    b.addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const n = all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]; n.focus(); n.click(); } });
  });
  $('#status').addEventListener('click', kick);
  $('#btnDir').addEventListener('click', openDirections);
  $('#btnLine').addEventListener('click', () => S.noMap ? toast('Map unavailable on this device.') : setView(S.view === 'line' ? 'map' : 'line'));
  $('#btnLocate').addEventListener('click', () => { if (S.view === 'line' && !S.noMap) setView('map'); locate(true); });
  $('#btnCompass').addEventListener('click', () => setFollow(null));
  $('#btnSettings').addEventListener('click', openSettings);
  $('#segRefresh').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.refreshSec = Number(b.dataset.v); store.set('refreshSec', S.refreshSec);
    $$('#segRefresh button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  $('#setDone').addEventListener('click', () => {
    const k = $('#keyInput').value.trim() || 'TEST';
    if (k !== S.key) { S.key = k; store.set('key', k); }
    closePanel('#settings'); kick();
  });
  $('#resetData').addEventListener('click', () => {
    store.del('line'); store.del('snap'); S.line = null; S.trips = {}; S.trains = {}; S.arr = null;
    closePanel('#settings'); kick();
  });
  $('#pickCancel').addEventListener('click', skipPicker);
  $('#pickSearch').addEventListener('input', renderPicker);
  $('#pickList').addEventListener('click', e => {
    if (e.target.closest('[data-near]')) { if (S.me) { const i = nearestStation(S.me); if (i >= 0) pickStation(S.line.stations[i].name); } else locate('near'); return; }
    const b = e.target.closest('[data-st]'); if (b) pickStation(b.dataset.st);
  });

  on('trainTap', selectTrain);
  on('stopTap', selectStop);
  on('busTap', ({ id, group }) => {
    if (group === 'track' && S.track) { S.track.sel = id; showTrackedBuses(); setFollow('bus'); }
    else if (group === 'plan') setFollow('plan');
  });
  on('mapTap', () => {
    if (S.mode === 'buses') { if (S.stop) closeStop(); }
    else if (S.selected) { S.selected = null; changed(); }
  });
  on('mapMoved', () => { if (S.mode === 'buses') loadStopsInView(); });
  on('mapReady', () => { M.drawMe(); M.padding(); if (S.mode === 'buses') loadStopsInView(); });
  on('sheetMoved', () => M.padding());
}

/* ================= start ================= */
function start() {
  M.setPanelSource(() => [visibleHeight(), isSide()]);
  initSheet(); initPanels(); initDirections(() => M.center() || CFG.north); wire();
  document.body.classList.toggle('mode-bus', S.mode === 'buses');
  $$('.modeseg button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === S.mode)));
  if (restoreLine()) setTimeout(() => loadLine(true).then(() => { M.refreshLine(); changed(); }, () => {}), 4000);   // week-old line data: refresh quietly
  loadSnapshot();
  render();
  try { M.initMap(); }
  catch {
    // no WebGL (old phone, battery saver, remote desktop): everything else still works in the line view
    S.noMap = true; document.body.classList.add('no-map'); setView('line');
    setTimeout(() => toast('Map unavailable on this device. Showing the line view.'), 600);
  }
  navigator.permissions?.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') locate(false); }, () => {}) ?? (store.get('locOk', false) && locate(false));
  if (S.mode === 'trains' && S.line && !hasTrip()) openPicker(stationIdx(S.from) < 0 ? 'from' : 'to', true);
  refresh(false);
  registerWorker();
}

function registerWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  const had = !!navigator.serviceWorker.controller, opened = Date.now();
  let reloaded = false;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => {
    r.update();
    // the app opens from the saved copy, so look for a new version whenever it comes back to the screen
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') r.update().catch(() => {}); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had || reloaded) return;
    // reload by itself only right after opening; otherwise offer it
    if (Date.now() - opened < 8000 || document.visibilityState === 'hidden') { reloaded = true; location.reload(); return; }
    if ($('.update-bar')) return;
    const bar = document.createElement('button');
    bar.type = 'button'; bar.className = 'update-bar'; bar.textContent = 'New version ready · Tap to reload';
    bar.addEventListener('click', () => { reloaded = true; location.reload(); });
    document.body.appendChild(bar);
  });
}

// a handle for debugging and automated tests
window.__lt = { S, M, fleet, oba, emit, refresh, setMode, startFind, selectStop };
start();
