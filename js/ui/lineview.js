/* Line view: one line as a strip map, north at the top, every train on it. Works without a map at all.
   Tabs switch between lines; trains from another line show up wherever they share the track. */
import { S } from '../state.js';
import { stationIdx, mainShape, isUp, rideTo, lineColor, lineText, lineBadge } from '../line.js';
import { where } from './views.js';
import { $, esc, project } from '../util.js';
import { gpsFresh } from '../trains.js';

const ROW = 52, PAD = 16;
const dots = new Map();      // tripId -> button

const viewed = () => (S.viewLine && S.lines[S.viewLine]) || S.line;
const short = name => name.replace(/\s+(City Center|Downtown|Station|Transit Center)$/i, '').replace(/^Downtown\s+/i, '');

export function buildDiagram() {
  const d = $('#diagram'), L = viewed();
  dots.forEach(b => b.remove()); dots.clear();
  if (!L) { d.innerHTML = '<div class="empty">Loading the line…</div>'; return; }
  $('#lineTabs').innerHTML = S.lineOrder.length > 1 ? S.lineOrder.map(id =>
    `<button type="button" data-line="${esc(id)}" aria-pressed="${id === L.route}"><span class="lbadge" style="background:${lineColor(id)};color:${lineText(id)}">${esc(lineBadge(id))}</span>${esc(S.lines[id].name)}</button>`).join('') : '';
  $('#lvTitle').textContent = L.name || 'Trains';
  d.style.setProperty('--line', lineColor(L.route));
  const n = L.stations.length, a = stationIdx(S.from, L), b = stationIdx(rideTo(), L), lo = Math.min(a, b), hi = Math.max(a, b), up = b > a;
  $('#lvDown').textContent = '↓ ' + short(L.stations[0].name);
  $('#lvUp').textContent = short(L.stations[n - 1].name) + ' ↑';
  const y = i => PAD + (n - 1 - i) * ROW + ROW / 2;
  let html = `<div class="rail" style="left:26px;top:${y(n - 1)}px;height:${y(0) - y(n - 1)}px"></div><div class="rail" style="right:26px;top:${y(n - 1)}px;height:${y(0) - y(n - 1)}px"></div>`;
  if (a >= 0 && b >= 0) html += `<div class="rail hot" style="${up ? 'right' : 'left'}:26px;top:${y(hi)}px;height:${y(lo) - y(hi)}px"></div>`;
  L.stations.forEach((st, i) => {
    const mine = a >= 0 && b >= 0 && i >= lo && i <= hi;
    html += `<div class="srow${mine ? ' mine' : ''}" style="top:${y(i) - ROW / 2}px">${esc(st.name)}${i === a && b >= 0 ? '<small>You board</small>' : i === b && a >= 0 ? '<small>Your stop</small>' : ''}</div>` +
      `<div class="sdot${mine && !up ? ' mine' : ''}" style="left:28px;top:${y(i)}px"></div><div class="sdot${mine && up ? ' mine' : ''}" style="right:22px;left:auto;top:${y(i)}px"></div>`;
  });
  d.style.height = PAD * 2 + n * ROW + 'px';
  d.innerHTML = html;
  $('#lvLead').textContent = a >= 0 && b >= 0 ? `Your trip: ${S.from} to ${S.to}` : 'Every train, live';
}

export function initLineTabs() {
  $('#lineTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-line]'); if (!b) return;
    S.viewLine = b.dataset.line; buildDiagram();
    $('#lineView').scrollTo?.({ top: 0, behavior: 'smooth' });
  });
}

/* every frame while the line view is open */
export function drawLine(t, yourId, onTap) {
  const L = viewed(), d = $('#diagram'), up = mainShape(L); if (!L || !up) return;
  const st = L.stations, n = st.length, W = d.clientWidth;
  for (const [k, b] of dots) if (!S.trains[k]) { b.remove(); dots.delete(k); }
  for (const k in S.trains) {
    const v = S.trains[k]; if (!v.cur) continue;
    // this line's trains, and other lines' trains where they run on this line's track (the 1 and 2 Lines share Lynnwood – International District)
    const pr = project(up, v.cur);
    const here = v.route === L.route || (!v.route && L === S.line) || pr.d < 120;
    let b = dots.get(k);
    if (!here) { if (b) { b.remove(); dots.delete(k); } continue; }
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.addEventListener('click', () => onTap(k)); d.appendChild(b); dots.set(k, b); }
    const other = v.route && v.route !== L.route;
    const cls = 'lt' + (gpsFresh(v) ? '' : ' nogps') + (k === yourId ? ' you' : '') + (other ? ' other-line' : '');
    if (b.className !== cls) {
      b.className = cls; b.textContent = isUp(v.dirId, v.route) ? '▲' : '▼';
      b.style.setProperty('--tc', lineColor(v.route || L.route));
    }
    if (!b._at || t - b._at > 5000) {
      b._at = t;
      const dm = Math.round(v.dev / 60);
      b.setAttribute('aria-label', `${S.lines[v.route]?.name || 'Train'} to ${v.headsign || (isUp(v.dirId, v.route) ? short(st[n - 1].name) : short(st[0].name))}, ${!gpsFresh(v) ? 'estimated position' : dm > 0 ? dm + ' min late' : dm < 0 ? -dm + ' min early' : 'on time'}, ${where(v).replace(/<[^>]+>/g, '')}`);
    }
    const s = pr.s;
    let fi = s <= st[0].s ? 0 : n - 1;
    for (let i = 0; i < n - 1; i++) if (s >= st[i].s && s < st[i + 1].s) { fi = i + (s - st[i].s) / Math.max(1, st[i + 1].s - st[i].s); break; }
    b.style.transform = `translate(${isUp(v.dirId, v.route) ? W - 28 : 28}px,${(PAD + (n - 1 - fi) * ROW + ROW / 2).toFixed(1)}px)`;
  }
}
