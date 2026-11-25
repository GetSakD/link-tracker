/* Line view: the whole 2 Line as a strip map, every train on it. Works without a map at all. */
import { S } from '../state.js';
import { stationIdx, mainShape, isUp } from '../line.js';
import { where } from './views.js';
import { $, esc, project } from '../util.js';
import { gpsFresh } from '../trains.js';

const ROW = 52, PAD = 16;
const dots = new Map();      // tripId -> button

export function buildDiagram() {
  const d = $('#diagram'), L = S.line;
  dots.forEach(b => b.remove()); dots.clear();
  if (!L) { d.innerHTML = '<div class="empty">Loading the line…</div>'; return; }
  const n = L.stations.length, a = stationIdx(S.from), b = stationIdx(S.to), lo = Math.min(a, b), hi = Math.max(a, b), up = b > a;
  const y = i => PAD + (n - 1 - i) * ROW + ROW / 2;
  let html = `<div class="rail" style="left:26px;top:${y(n - 1)}px;height:${y(0) - y(n - 1)}px"></div><div class="rail" style="right:26px;top:${y(n - 1)}px;height:${y(0) - y(n - 1)}px"></div>`;
  if (a >= 0 && b >= 0) html += `<div class="rail hot" style="${up ? 'right' : 'left'}:26px;top:${y(hi)}px;height:${y(lo) - y(hi)}px"></div>`;
  L.stations.forEach((st, i) => {
    const mine = a >= 0 && i >= lo && i <= hi;
    html += `<div class="srow${mine ? ' mine' : ''}" style="top:${y(i) - ROW / 2}px">${esc(st.name)}${i === a ? '<small>You board</small>' : i === b ? '<small>Your stop</small>' : ''}</div>` +
      `<div class="sdot${mine && !up ? ' mine' : ''}" style="left:28px;top:${y(i)}px"></div><div class="sdot${mine && up ? ' mine' : ''}" style="right:22px;left:auto;top:${y(i)}px"></div>`;
  });
  d.style.height = PAD * 2 + n * ROW + 'px';
  d.innerHTML = html;
  $('#lvLead').textContent = a >= 0 && b >= 0 ? `Your trip: ${S.from} to ${S.to}` : 'Every train, live';
}

/* every frame while the line view is open */
export function drawLine(t, yourId, onTap) {
  const L = S.line, d = $('#diagram'), up = mainShape(); if (!L || !up) return;
  const st = L.stations, n = st.length, W = d.clientWidth;
  for (const [k, b] of dots) if (!S.trains[k]) { b.remove(); dots.delete(k); }
  for (const k in S.trains) {
    const v = S.trains[k]; if (!v.cur) continue;
    let b = dots.get(k);
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.addEventListener('click', () => onTap(k)); d.appendChild(b); dots.set(k, b); }
    const cls = 'lt' + (gpsFresh(v) ? '' : ' nogps') + (k === yourId ? ' you' : '');
    if (b.className !== cls) { b.className = cls; b.textContent = isUp(v.dirId) ? '▲' : '▼'; }
    if (!b._at || t - b._at > 5000) {
      b._at = t;
      const dm = Math.round(v.dev / 60);
      b.setAttribute('aria-label', `Train to ${v.headsign || (isUp(v.dirId) ? 'Lynnwood' : 'Redmond')}, ${!gpsFresh(v) ? 'estimated position' : dm > 0 ? dm + ' min late' : dm < 0 ? -dm + ' min early' : 'on time'}, ${where(v).replace(/<[^>]+>/g, '')}`);
    }
    const s = project(up, v.cur).s;
    let fi = s <= st[0].s ? 0 : n - 1;
    for (let i = 0; i < n - 1; i++) if (s >= st[i].s && s < st[i + 1].s) { fi = i + (s - st[i].s) / Math.max(1, st[i + 1].s - st[i].s); break; }
    b.style.transform = `translate(${isUp(v.dirId) ? W - 28 : 28}px,${(PAD + (n - 1 - fi) * ROW + ROW / 2).toFixed(1)}px)`;
  }
}
