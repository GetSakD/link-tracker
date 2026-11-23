/* The panel. On phones it's a bottom sheet with three heights (peek, mid, full) that moves on a
   spring: it follows your finger 1:1, keeps your flick's speed when you let go, can be grabbed
   mid-flight, and never jumps. On wide screens it's a card in the top-left corner (Apple Maps on iPad/Mac). */
import { CFG } from '../config.js';
import { S, emit } from '../state.js';
import { Spring, addTask } from '../loop.js';
import { $, clamp } from '../util.js';

let sheet, spring, dragging = false;
export const isSide = () => window.innerWidth >= 700;
const fullH = () => sheet.getBoundingClientRect().height || window.innerHeight * 0.92;
export function heights() {
  const H = fullH();
  return { peek: Math.min(206, H), mid: Math.round(Math.min(H, window.innerHeight * 0.52)), full: H };
}
export const visibleHeight = () => isSide() ? 0 : heights()[S.detent];
const offsetFor = d => fullH() - heights()[d];             // translateY that shows detent d

function apply(y) {
  sheet.style.transform = `translate3d(0,${y.toFixed(1)}px,0)`;
  document.documentElement.style.setProperty('--sheet-h', Math.max(0, fullH() - y) + 'px');
}

export function setDetent(d, { animate = true, velocity } = {}) {
  S.detent = d;
  const side = isSide();
  document.body.classList.toggle('side', side);
  for (const k of ['peek', 'mid', 'full']) document.body.classList.toggle('side-' + k, side && d === k);
  document.body.classList.toggle('sheet-full', !side && d === 'full');
  if (side) { sheet.style.transform = ''; document.documentElement.style.setProperty('--sheet-h', '0px'); emit('sheetMoved'); return; }
  if (animate) spring.to(offsetFor(d), velocity); else { spring.jump(offsetFor(d)); apply(spring.x); emit('sheetMoved'); }
}

export function initSheet() {
  sheet = $('#sheet');
  spring = new Spring(window.innerHeight, { response: 0.45, damping: 0.86 });
  let settled = true;
  addTask((t, dt) => {
    if (dragging || isSide()) return false;
    if (settled && spring.x === spring.target && spring.v === 0) return false;   // nothing to do
    const moving = spring.step(dt);
    apply(spring.x);
    settled = !moving;
    if (settled) emit('sheetMoved');           // once, when it comes to rest
    return moving;
  });

  // grab handle: tap cycles; on wide screens it folds the card
  $('#grab').addEventListener('click', () => {
    if (moved) return;
    setDetent(isSide() ? (S.detent === 'peek' ? 'mid' : 'peek') : S.detent === 'peek' ? 'mid' : S.detent === 'mid' ? 'full' : 'mid');
  });

  let startY = 0, base = 0, moved = false, samples = [];
  sheet.addEventListener('pointerdown', e => {
    if (isSide() || !e.target.closest('.drag-zone') || e.target.closest('button:not(#grab),a,input,summary')) return;
    dragging = true; moved = false; startY = e.clientY; base = spring.x; samples = [[performance.now(), e.clientY]];
    try { sheet.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
  });
  sheet.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dy = e.clientY - startY; if (Math.abs(dy) > 4) moved = true;
    const min = 0, max = fullH() - 120;
    let y = base + dy;
    if (y < min) y = min - Math.sqrt(min - y) * 3;          // rubber band past the top
    spring.x = clamp(y, -60, max); spring.v = 0; apply(spring.x);
    samples.push([performance.now(), e.clientY]); if (samples.length > 5) samples.shift();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (!moved) { spring.to(spring.target); return; }
    const [t0, y0] = samples[0], [t1, y1] = samples.at(-1), v = t1 > t0 ? (y1 - y0) / (t1 - t0) * 1000 : 0;   // px/s
    const projected = spring.x + v * 0.18, h = heights(), H = fullH();
    const best = ['peek', 'mid', 'full'].reduce((a, d) => Math.abs(H - h[d] - projected) < Math.abs(H - h[a] - projected) ? d : a, 'mid');
    setDetent(best, { velocity: v });
    setTimeout(() => { moved = false; }, 0);
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => setDetent(S.detent, { animate: false }));
  setDetent(isSide() ? 'mid' : 'peek', { animate: false });
}

export const sideWidth = CFG.sideWidth;
