/* The directions panel: pick a start and a destination, then plan. */
import { ICON } from '../config.js';
import { S, emit } from '../state.js';
import { geocode } from '../plan.js';
import * as P from './parts.js';
import { openPanel, closePanel, toast } from './panels.js';
import { $, $$, esc, miles, dist } from '../util.js';
import { morph } from './dom.js';

export const D = { from: null, to: null, field: 'to', mode: 'all', results: [], timer: 0 };

export function openDirections() {
  D.field = 'to';
  $('#dirSearch').value = '';
  sync(); results([]);
  openPanel('#dirs');
  setTimeout(() => $('#dirSearch').focus(), 350);
}
function sync() {
  $('#dirFromTxt').textContent = D.from ? D.from.name : 'My Location';
  $('#dirToTxt').textContent = D.to ? D.to.name : 'Choose destination';
  $('#dirToTxt').classList.toggle('muted', !D.to);
  $('#dirSearchLabel').textContent = D.field === 'from' ? 'Search starting point' : 'Search destination';
  $('#dirSearch').placeholder = D.field === 'from' ? 'Where are you starting?' : 'Address, place or stop';
  $$('#dirModes button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === D.mode)));
}
function results(list) {
  D.results = list;
  let html = '';
  if (D.field === 'from') html += P.section('&nbsp;') + '<div class="group">' + P.cell({ attrs: 'data-cur="1"', ico: `<span class="loc-ico">${ICON.locate}</span>`, text: 'My Location', color: 'var(--blue)' }) + '</div>';
  if (list.length) html += P.section('Results') + '<div class="group">' + list.map((x, i) => {
    const area = (x.areas || []).find(a => !/United States|Washington/.test(a.name))?.name;
    const sub = [x.street ? (x.houseNumber ? x.houseNumber + ' ' : '') + x.street : '', area].filter(Boolean).join(', ');
    return P.cell({ attrs: `data-gi="${i}" data-key="${esc(x.id || x.name + i)}"`, cls: 'ind-40', ico: x.type === 'STOP' ? P.stopIcon() : `<span class="loc-ico red">${ICON.pin}</span>`,
      text: esc(x.name), sub: sub ? `<span class="sub">${esc(sub)}</span>` : '', right: S.me ? `<span class="r num">${miles(dist(x, S.me))}</span>` : '' });
  }).join('') + '</div>';
  else if ($('#dirSearch').value.trim().length >= 2) html += P.empty('Searching…');
  morph($('#dirResults'), html);
}
function choose(x) {
  const p = { name: x.name, lat: x.lat, lon: x.lon };
  if (D.field === 'from') { D.from = p; D.field = 'to'; } else D.to = p;
  $('#dirSearch').value = ''; results([]); sync();
  if (D.to && (D.from || S.me)) go();
}
function go() {
  if (!D.to) { toast('Choose where you want to go.'); return; }
  if (!D.from && !S.me) { D.field = 'from'; sync(); results([]); toast('Turn on location, or choose a starting point.'); emit('needLocation'); return; }
  closePanel('#dirs');
  emit('plan', { from: D.from || { ...S.me, name: 'My Location' }, to: D.to, mode: D.mode });
}

export function initDirections(center) {
  $('#dirCancel').addEventListener('click', () => closePanel('#dirs'));
  $('#dirGo').addEventListener('click', go);
  $('#dirFromBtn').addEventListener('click', () => { D.field = 'from'; sync(); results([]); $('#dirSearch').focus(); });
  $('#dirToBtn').addEventListener('click', () => { D.field = 'to'; sync(); results([]); $('#dirSearch').focus(); });
  $('#dirModes').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { D.mode = b.dataset.m; sync(); } });
  $('#dirSearch').addEventListener('input', function () {
    clearTimeout(D.timer);
    const q = this.value.trim();
    results([]);
    if (q.length < 2) return;
    D.timer = setTimeout(() => geocode(q, S.me || center()).then(list => { if ($('#dirSearch').value.trim() === q) results(list); }, e => toast(e.message)), 300);
  });
  $('#dirResults').addEventListener('click', e => {
    if (e.target.closest('[data-cur]')) { D.from = null; D.field = 'to'; sync(); results([]); if (!S.me) emit('needLocation'); return; }
    const b = e.target.closest('[data-gi]'); if (b) choose(D.results[Number(b.dataset.gi)]);
  });
}
