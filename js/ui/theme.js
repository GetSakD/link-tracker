/* Appearance: color themes, font and text size. Saved on the phone and applied before the first paint
   (see the small script in index.html), so the app never flashes the wrong colors. */
import { $, $$, store, isDark } from '../util.js';
import { emit } from '../state.js';

export const THEMES = [
  { id: 'auto',   name: 'Match iPhone', bg: 'linear-gradient(135deg,#F2F2F7 50%,#1C1C1E 50%)', fg: '#007AFF' },
  { id: 'light',  name: 'Light',        bg: '#F2F2F7', fg: '#000' },
  { id: 'dark',   name: 'Dark',         bg: '#1C1C1E', fg: '#fff' },
  { id: 'paper',  name: 'Paper',        bg: '#ECE9E4', fg: '#141414', font: 'system' },
  { id: 'violet', name: 'Violet',       bg: '#FFFFFF', fg: '#6B21E8', font: 'mono' },
  { id: 'forest', name: 'Forest',       bg: '#22372B', fg: '#FFFFFF', font: 'chalk' }
];
export const FONTS = [
  { id: 'system',  name: 'Default' },
  { id: 'rounded', name: 'Rounded' },
  { id: 'mono',    name: 'Mono' },
  { id: 'chalk',   name: 'Chalk' },
  { id: 'legible', name: 'Easy read' }
];
const FONT_CSS = { system: '-apple-system,BlinkMacSystemFont,system-ui,sans-serif', rounded: 'ui-rounded,"SF Pro Rounded",-apple-system,system-ui,sans-serif',
  mono: 'ui-monospace,"SF Mono",Menlo,monospace', chalk: '"Chalkboard SE","Comic Sans MS","Comic Neue",cursive', legible: '"Atkinson Hyperlegible",-apple-system,system-ui,sans-serif' };

const A = { theme: store.get('theme', 'auto'), font: store.get('font', 'system'), zoom: store.get('zoom', 1) };

function loadLegible() {
  if (A.font !== 'legible' || document.getElementById('font-legible')) return;
  const l = document.createElement('link');
  l.id = 'font-legible'; l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap';
  document.head.appendChild(l);
}

export function applyAppearance() {
  const d = document.documentElement, wasDark = isDark();
  d.dataset.theme = A.theme; d.dataset.font = A.font;
  d.style.setProperty('--zoom', A.zoom);
  loadLegible();
  // the iPhone status bar and Safari toolbar take the theme's background color
  const bg = getComputedStyle(d).getPropertyValue('--bg').trim();
  $$('meta[name="theme-color"]').forEach(m => { if (A.theme !== 'auto') { m.setAttribute('content', bg); m.removeAttribute('media'); } });
  if (wasDark !== isDark()) emit('themeChanged');
}

function sync() {
  $$('#themeGrid button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === A.theme)));
  $$('#fontRow button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.font === A.font)));
  $('#zoomRange').value = A.zoom;
  $('#zoomVal').textContent = Math.round(A.zoom * 100) + '%';
}

export function initAppearance() {
  $('#themeGrid').innerHTML = THEMES.map(t =>
    `<button type="button" data-theme="${t.id}" aria-label="${t.name} theme"><span class="sw" style="background:${t.bg};color:${t.fg}${t.font ? ';font-family:' + FONT_CSS[t.font].replace(/"/g, '&quot;') : ''}">Aa</span><span class="nm">${t.name}</span></button>`).join('');
  $('#fontRow').innerHTML = FONTS.map(f => `<button type="button" data-font="${f.id}" style="font-family:${FONT_CSS[f.id].replace(/"/g, '&quot;')}">${f.name}</button>`).join('');
  $('#themeGrid').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const t = THEMES.find(x => x.id === b.dataset.theme);
    A.theme = t.id; store.set('theme', A.theme);
    if (t.font) { A.font = t.font; store.set('font', A.font); }   // each preset comes with its font; change it below if you like
    applyAppearance(); sync();
  });
  $('#fontRow').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    A.font = b.dataset.font; store.set('font', A.font); applyAppearance(); sync();
  });
  $('#zoomRange').addEventListener('input', e => {
    A.zoom = Math.round(Number(e.target.value) * 100) / 100; store.set('zoom', A.zoom);
    document.documentElement.style.setProperty('--zoom', A.zoom); sync();
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => { if (A.theme === 'auto') applyAppearance(); });
  applyAppearance(); sync();
}
