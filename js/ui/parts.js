/* Reusable pieces of the panel, so every screen looks and behaves the same. */
import { ICON } from '../config.js';
import { S, now } from '../state.js';
import { routeName, routeColor, routeText } from '../api.js';
import { esc, clock, miles, dist, plural, $$ } from '../util.js';

export function minutes(t) {
  const m = Math.round((t - now()) / 60000);
  if (m <= 0) return { n: 'Now', u: '' };
  if (m >= 60) return { n: Math.floor(m / 60) + 'h', u: (m % 60) + 'm' };
  return { n: String(m), u: 'min' };
}
const cdInner = (m, big) => big ? `<b>${m.n}</b>${m.u ? `<small>${m.u}</small>` : ''}` : `<span>${m.n}</span>${m.u ? `<small>${m.u}</small>` : ''}`;
// a countdown that ticks by itself and rolls to the next number like a departure board
export function countdown(t, big = false) {
  const m = minutes(t);
  return `<span data-live data-cd="${t}"${big ? ' data-big' : ''} data-v="${m.n + m.u}">${cdInner(m, big)}</span>`;
}
export function tick() {
  for (const el of $$('[data-cd]')) {
    const m = minutes(Number(el.dataset.cd)), key = m.n + m.u;
    if (el.dataset.v === key) continue;
    el.dataset.v = key;
    el.innerHTML = cdInner(m, el.hasAttribute('data-big')).replace(/^<(b|span)>/, '<$1 class="tick">');
  }
  for (const el of $$('[data-ago]')) {
    const s = Math.max(0, Math.round((now() - Number(el.dataset.ago)) / 1000));
    el.textContent = s < 60 ? s + 's ago' : Math.round(s / 60) + ' min ago';
  }
}

export function chip(dev, live, canceled) {
  if (canceled) return '<span class="chip cancel">Canceled</span>';
  // no live data yet: the timetable time (buses usually start reporting shortly before their trip)
  if (!live) return `<span class="chip sched" title="No live data yet, so this is the timetable time">${ICON.clock}Scheduled</span>`;
  const m = Math.round(dev / 60);
  return m === 0 ? `<span class="chip ok">${ICON.live}On time</span>` : m > 0 ? `<span class="chip late">${ICON.live}${m} min late</span>` : `<span class="chip early">${ICON.live}${-m} min early</span>`;
}

export const badge = (name, bg, fg, small) => `<span class="rb${small ? ' sm' : ''}" style="background:${esc(bg)};color:${esc(fg)}">${esc(name)}</span>`;
export const routeBadge = (r, small) => badge(routeName(r), routeColor(r), routeText(r), small);
export const closeBtn = (act, label = 'Close') => `<button class="close" type="button" data-act="${act}" aria-label="${esc(label)}">${ICON.close}</button>`;
export const followBtn = (act, on) => `<button class="pill-btn${on ? '' : ' tinted'}" type="button" data-act="${act}">${on ? 'Following' : 'Follow'}</button>`;
export const skeleton = (n = 2, h = 64) => Array.from({ length: n }, (_, i) => `<div class="skel" style="height:${h}px;margin-top:${i ? 8 : 16}px"></div>`).join('');
export const empty = text => `<div class="empty">${text}</div>`;
export const section = (title, right = '') => `<div class="sec"><span>${title}</span>${right}</div>`;
export const foot = text => `<p class="foot">${text}</p>`;
export const stopsAway = n => n > 0 ? plural(n, 'stop') + ' away' : '';
export const away = p => S.me && p ? miles(dist(S.me, p)) : '';

// header used by every detail screen: icon, title, subtitle, close
export const header = (ico, title, sub, act, label, extra = '') =>
  `<div class="drag-zone"><div class="d-head">${ico}<div class="d-title"><h2>${esc(title)}</h2><div>${sub}</div></div>${closeBtn(act, label)}</div>${extra}</div>`;
export const intro = (title, sub) => `<div class="drag-zone"><div class="intro"><h2>${esc(title)}</h2><p>${sub}</p></div></div>`;

export const stopIcon = (big) => `<span class="stop-ico${big ? ' big' : ''}">${ICON.bus}</span>`;
export function cell({ act, attrs = '', ico = '', text, sub = '', right = '', cls = '', color = '' }) {
  return `<button class="cell${cls ? ' ' + cls : ''}" type="button"${act ? ` data-act="${act}"` : ''} ${attrs}>${ico}<span class="v"${color ? ` style="color:${color}"` : ''}>${text}${sub}</span>${right}</button>`;
}
export const timeRow = (t, small) => `<div class="t num">${clock(t)}<small>${small || '&nbsp;'}</small></div>`;
