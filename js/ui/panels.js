/* The full-screen panels (station picker, directions, settings), the toast and the status pill. */
import { ICON } from '../config.js';
import { S, now, emit } from '../state.js';
import { stationMatches, nearestStation, allStations, chooseLine, lineColor, lineText, lineBadge } from '../line.js';
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
// small coloured squares for the lines that stop at a station
export const lineChips = ids => `<span class="st-icos" aria-hidden="true">${ids.map(id =>
  `<span class="st-ico" style="background:${lineColor(id)};color:${lineText(id)}">${esc(lineBadge(id))}</span>`).join('')}</span>`;

export function renderPicker() {
  if (!pick) return;
  const list = $('#pickList'), q = $('#pickSearch').value.trim();
  if (!S.line) { morph(list, P.empty('Loading stations…')); return; }
  const cur = pick.which === 'from' ? S.from : S.to, near = nearestStation(S.me), all = allStations();
  const nearSt = all.find(s => s.name === near);
  let html = '';
  if (!q && 'geolocation' in navigator) html += P.section('&nbsp;') + '<div class="group">' + P.cell({ attrs: 'data-near="1"', ico: `<span class="loc-ico">${ICON.locate}</span>`,
    text: nearSt ? 'Nearest: ' + esc(nearSt.name) : 'Use Current Location', color: 'var(--blue)', right: nearSt ? `<span class="r">${miles(dist(nearSt, S.me))}</span>` : '' }) + '</div>';
  const row = st => P.cell({ attrs: `data-st="${esc(st.name)}" data-key="${esc(st.name)}"`, cls: 'st-row',
    ico: lineChips(st.lines), text: esc(st.name) + (st.name === near ? ' <span class="near">Nearest</span>' : ''),
    right: (S.me ? `<span class="r num">${miles(dist(st, S.me))}</span>` : '') + (st.name === cur ? '<span class="check">✓</span>' : '') });
  if (q) {
    const hits = all.filter(st => stationMatches(st.name, q));
    html += P.section('Stations') + '<div class="group">' + hits.map(row).join('') + (hits.length ? '' : P.empty(`No station matches “${esc(q)}”.`)) + '</div>';
  } else {
    // one section per line, north to south; a station shared with an earlier line is listed only once
    const shown = new Set();
    for (const id of S.lineOrder) {
      const sts = S.lines[id].stations.slice().reverse().filter(st => !shown.has(st.name));
      if (!sts.length) continue;
      sts.forEach(st => shown.add(st.name));
      const L = S.lines[id], label = esc(L.name) + (L.long ? ` <span class="sec-sub">${esc(L.long.replace(/\s*-\s*/g, ' – '))}</span>` : '');
      html += P.section(label) + '<div class="group">' + sts.map(st => row(all.find(x => x.name === st.name))).join('') + '</div>';
    }
  }
  morph(list, html);
}
export function pickStation(name) {
  const { which, firstRun } = pick;
  const other = which === 'from' ? S.to : S.from;
  if (name === other) [S.from, S.to] = [S.to, S.from];
  else S[which] = name;
  store.set('from', S.from); store.set('to', S.to);
  chooseLine();
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
