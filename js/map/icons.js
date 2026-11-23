/* Map icons, drawn once into canvases and handed to the GPU. Two pixels per point keeps them crisp. */
import { cssVar, isDark } from '../util.js';

const R = 2;
const ROUND = 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif';

function paint(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(w * R); cv.height = Math.ceil(h * R);
  const c = cv.getContext('2d'); c.scale(R, R); draw(c);
  return { width: cv.width, height: cv.height, data: c.getImageData(0, 0, cv.width, cv.height).data };
}
function rr(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
function shade(hex, k) {
  const n = parseInt(hex.replace('#', ''), 16), f = v => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return `rgb(${f(n >> 16 & 255)},${f(n >> 8 & 255)},${f(n & 255)})`;
}
const measure = (text, font) => { const c = document.createElement('canvas').getContext('2d'); c.font = font; return c.measureText(text).width; };

/* train: a round "2" badge. kinds: live (your direction), other (opposite), nogps (dashed), you */
export function trainBadge(kind) {
  const you = kind === 'you', S0 = you ? 40 : 30, dark = isDark();
  const fill = { other: '#8E8E93', nogps: dark ? '#2C2C2E' : '#FFFFFF', you: cssVar('--blue') || '#0A84FF' }[kind] || cssVar('--line') || '#007CAD';
  return paint(S0, S0, c => {
    const cx = S0 / 2, r = S0 / 2 - 3;
    c.shadowColor = 'rgba(0,0,0,.3)'; c.shadowBlur = 5; c.shadowOffsetY = 1.5;
    c.beginPath(); c.arc(cx, cx, r, 0, Math.PI * 2); c.fillStyle = fill; c.fill();
    c.shadowColor = 'transparent';
    c.lineWidth = 2.5; c.strokeStyle = kind === 'nogps' ? (dark ? '#AEAEB2' : '#6C6C70') : '#FFFFFF';
    if (kind === 'nogps') c.setLineDash([3, 2.5]);
    c.beginPath(); c.arc(cx, cx, r - 1.25, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    c.fillStyle = kind === 'nogps' ? (dark ? '#EBEBF5' : '#3C3C43') : '#FFFFFF';
    c.font = `700 ${you ? 15 : 12}px ${ROUND}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('2', cx, cx + 0.5);
  });
}
export function trainArrow(kind) {
  const S0 = kind === 'you' ? 52 : 42;
  const col = kind === 'you' ? cssVar('--blue') || '#0A84FF' : kind === 'live' ? cssVar('--line') || '#007CAD' : '#8E8E93';
  return paint(S0, S0, c => {
    c.shadowColor = 'rgba(255,255,255,.9)'; c.shadowBlur = 2;
    c.beginPath(); c.moveTo(S0 / 2, 0.5); c.lineTo(S0 / 2 + 5, 7.5); c.lineTo(S0 / 2 - 5, 7.5); c.closePath(); c.fillStyle = col; c.fill();
  });
}
/* "Your train · 4 min" tag; redrawn only when the text changes */
export function tag(text) {
  const font = '600 12px -apple-system, system-ui, sans-serif', W = Math.ceil(measure(text, font)) + 20;
  return paint(W, 31, c => {
    c.fillStyle = cssVar('--blue') || '#0A84FF';
    rr(c, 0, 0, W, 25, 9); c.fill();
    c.beginPath(); c.moveTo(W / 2 - 5, 25); c.lineTo(W / 2 + 5, 25); c.lineTo(W / 2, 30); c.closePath(); c.fill();
    c.fillStyle = '#FFFFFF'; c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, W / 2, 13);
  });
}
/* a bus seen from above, nose up, in its route colour */
export function busTop(color) {
  return paint(30, 58, c => {
    const x = 6, y = 5, w = 18, h = 46;
    c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 6; c.shadowOffsetY = 2;
    rr(c, x, y, w, h, 5); c.fillStyle = color; c.fill();
    c.shadowColor = 'transparent';
    const g = c.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, shade(color, -0.25)); g.addColorStop(0.5, shade(color, 0.18)); g.addColorStop(1, shade(color, -0.25));
    rr(c, x + 2.5, y + 9, w - 5, h - 14, 3); c.fillStyle = g; c.fill();                 // roof
    c.fillStyle = 'rgba(20,28,38,.88)';
    rr(c, x + 1.6, y + 1.6, w - 3.2, 6.4, 3); c.fill();                                 // windshield
    rr(c, x + 3, y + h - 4.4, w - 6, 2.6, 1.3); c.fill();                               // rear window
    c.fillStyle = 'rgba(255,255,255,.55)';
    for (let i = 0; i < 4; i++) { rr(c, x + 5.5, y + 13 + i * 8, w - 11, 3, 1.5); c.fill(); }
    c.lineWidth = 1.6; c.strokeStyle = '#FFFFFF'; rr(c, x, y, w, h, 5); c.stroke();
    c.fillStyle = '#FFF6C2'; c.beginPath(); c.arc(x + 3.5, y + 1.2, 1.2, 0, 7); c.arc(x + w - 3.5, y + 1.2, 1.2, 0, 7); c.fill();
  });
}
export function routeLabel(text, color, fg) {
  const font = `700 12px ${ROUND}`, W = Math.max(26, Math.ceil(measure(text, font)) + 14), H = 20;
  return paint(W + 4, H + 4, c => {
    c.shadowColor = 'rgba(0,0,0,.3)'; c.shadowBlur = 4; c.shadowOffsetY = 1;
    rr(c, 2, 2, W, H, 7); c.fillStyle = color; c.fill(); c.shadowColor = 'transparent';
    c.lineWidth = 1.6; c.strokeStyle = '#FFFFFF'; c.stroke();
    c.fillStyle = fg; c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 2 + W / 2, 2 + H / 2 + 0.5);
  });
}
export function stopSign(color = '#1A8597') {
  return paint(26, 26, c => {
    rr(c, 1, 1, 24, 24, 7); c.fillStyle = '#FFFFFF'; c.fill();
    rr(c, 3, 3, 20, 20, 5.5); c.fillStyle = color; c.fill();
    c.fillStyle = '#FFFFFF'; rr(c, 8, 7, 10, 10.5, 2.2); c.fill();
    c.fillStyle = color; c.fillRect(9.3, 8.6, 7.4, 4);
    c.fillStyle = '#FFFFFF'; c.fillRect(9, 17.2, 2, 2.3); c.fillRect(15, 17.2, 2, 2.3);
  });
}
export const PIXEL_RATIO = R;
