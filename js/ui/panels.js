/* The full-screen panels (station picker, directions, settings), the toast and the status pill. */
import { ICON } from '../config.js';
import { S, now, emit } from '../state.js';
import { stationMatches, nearestStation } from '../line.js';
import * as P from './parts.js';
import { $, $$, esc, miles, dist, store } from '../util.js';
import { morph } from './dom.js';

/* ---------- panels: open/close with focus handled and the page behind made inert ---------- */
const MAIN = ['#map', '.top', '#sheet', '#lineView'];
let returnFocus = null;
export function openPanel(id) {
  const m = $(id); if (m.classList.contains('open')) return;
  returnFocus = document.activeElement;
  m.classList.add('open'); m.inert = false; m.setAttribute('aria-hidden', 'false');
  MAIN.forEach(s => { const el = $(s); if (el) el.inert = true; });
  setTimeout(() => { if (!m.contains(document.activeElement)) m.querySelector('input,button')?.focus({ preventScroll: true }); }, 60);
}
export function closePanel(id) {
  const m = $(id); if (!m.classList.contains('open')) return;
  m.classList.remove('open'); m.inert = true; m.setAttribute('aria-hidden', 'true');
  if (!$('.modal.open')) MAIN.forEach(s => { const el = $(s); if (el) el.inert = false; });
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}
export function initPanels() {
  $$('.modal').forEach(m => { m.inert = true; m.setAttribute('aria-hidden', 'true'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if ($('#picker').classList.contains('open')) closePicker(); closePanel('#dirs'); closePanel('#settings'); } });
}

/* ---------- toast ---------- */
let toastTimer = 0;
export function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}

/* ---------- status pill: honest about how fresh the data is ---------- */
export function updateStatus() {
  const el = $('#status'), age = S.lastOk ? (now() - S.lastOk) / 1000 : Infinity;
  // say what actually went wrong: Sound Transit rate-limiting us is not the phone being offline
  const busy = !!S.busyAt && Date.now() - S.busyAt < 60000, offline = navigator.onLine === false;
  const why = busy ? 'Busy · retrying' : offline ? 'Offline' : 'No answer';
  let cls = 'ok', label = 'Live';
  if (S.keyBad) { cls = 'err'; label = 'Key rejected'; }
  else if (!S.lastOk) { cls = S.err ? (busy ? 'warn' : 'err') : ''; label = S.err ? why : 'Connecting…'; }
  else if (S.err && age > S.refreshSec * 2) { cls = busy ? 'warn' : 'err'; label = why + (busy ? '' : ' · ' + Math.round(age / 60) + 'm ago'); }
  else if (age > S.refreshSec * 3 + 10) { cls = 'warn'; label = 'Updated ' + Math.round(age / 60) + 'm ago'; }
  el.className = 'status glass ' + cls;
  $('#statusText').textContent = label;
  el.setAttribute('aria-label', label + (S.lastOk ? ', updated ' + Math.max(0, Math.round(age / 60)) + ' min ago' : '') + '. Refresh now');
  // countdowns older than two refreshes are greyed so a frozen number never looks live
  document.body.classList.toggle('stale', S.keyBad || (!!S.lastOk && age > S.refreshSec * 2 + 15));
}

/* ---------- station picker ---------- */
let pick = null;     // { which: 'from'|'to', firstRun }
export const pickerOpen = () => !!pick;
export function openPicker(which, firstRun = false) {
  pick = { which, firstRun };
  $('#pickTitle').textContent = which === 'from' ? (firstRun ? 'Where are you starting?' : 'Starting Station') : (firstRun ? 'Where are you going?' : 'Destination');
  $('#pickCancel').textContent = firstRun ? 'Skip' : 'Cancel';
  $('#pickSearch').value = '';
  renderPicker();
  openPanel('#picker');
}
export function closePicker() { if (pick?.firstRun) S.pickDismissed = true; pick = null; closePanel('#picker'); }
export function renderPicker() {
  if (!pick) return;
  const L = S.line, list = $('#pickList'), q = $('#pickSearch').value.trim();
  if (!L) { morph(list, P.empty('Loading stations…')); return; }
  const cur = pick.which === 'from' ? S.from : S.to, near = nearestStation(S.me);
  let html = '';
  if (!q && 'geolocation' in navigator) html += P.section('&nbsp;') + '<div class="group">' + P.cell({ attrs: 'data-near="1"', ico: `<span class="loc-ico">${ICON.locate}</span>`,
    text: near >= 0 ? 'Nearest: ' + esc(L.stations[near].name) : 'Use Current Location', color: 'var(--blue)', right: near >= 0 ? `<span class="r">${miles(dist(L.stations[near], S.me))}</span>` : '' }) + '</div>';
  const rows = L.stations.map((st, i) => ({ st, i })).reverse().filter(o => !q || stationMatches(o.st.name, q));
  html += P.section('2 Line stations') + '<div class="group">' + rows.map(({ st, i }) => P.cell({ attrs: `data-st="${esc(st.name)}" data-key="${esc(st.name)}"`, cls: 'ind-40',
    ico: '<span class="st-ico" aria-hidden="true">2</span>', text: esc(st.name) + (i === near ? ' <span class="near">Nearest</span>' : ''),
    right: (S.me ? `<span class="r num">${miles(dist(st, S.me))}</span>` : '') + (st.name === cur ? '<span class="check">✓</span>' : '') })).join('') +
    (rows.length ? '' : P.empty(`No station matches “${esc(q)}”.`)) + '</div>';
  morph(list, html);
}
export function pickStation(name) {
  const { which, firstRun } = pick;
  const other = which === 'from' ? S.to : S.from;
  if (name === other) [S.from, S.to] = [S.to, S.from];
  else S[which] = name;
  store.set('from', S.from); store.set('to', S.to);
  closePicker();
  emit('tripChanged');
  if (firstRun && which === 'from' && !S.to) setTimeout(() => openPicker('to', true), 380);
}
export function skipPicker() {
  if (pick?.firstRun && S.line) {     // sensible defaults: the whole line
    const st = S.line.stations;
    if (!st.some(s => s.name === S.from)) S.from = st[0].name;
    if (!st.some(s => s.name === S.to) || S.to === S.from) S.to = st.at(-1).name;
    store.set('from', S.from); store.set('to', S.to);
    emit('tripChanged');
  }
  closePicker();
}

/* ---------- settings ---------- */
export function openSettings() {
  $('#keyInput').value = S.key === 'TEST' ? '' : S.key;
  $('#keyInput').classList.add('masked'); $('#keyShow').textContent = 'Show'; $('#keyShow').setAttribute('aria-pressed', 'false');
  $$('#segRefresh button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === S.refreshSec)));
  openPanel('#settings');
}
