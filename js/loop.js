/* One animation loop for the whole app, at the screen's refresh rate.
   Tasks return true while they still have something moving; when nothing moves the loop sleeps
   (no wasted frames, no battery drain) until wake() is called. */
const tasks = new Set();
let running = false, last = 0;

export function addTask(fn) { tasks.add(fn); wake(); return () => tasks.delete(fn); }

export function wake() {
  if (running || document.visibilityState === 'hidden') return;
  running = true; last = 0;
  requestAnimationFrame(tick);
}

function tick(t) {
  const dt = last ? Math.min(100, t - last) : 16;
  last = t;
  let busy = false;
  for (const fn of tasks) { try { if (fn(t, dt)) busy = true; } catch (e) { console.error(e); } }
  if (busy && document.visibilityState !== 'hidden') requestAnimationFrame(tick);
  else running = false;
}

document.addEventListener('visibilitychange', wake);

/* A spring, the way iOS animates: no fixed duration, keeps its velocity when interrupted. */
export class Spring {
  constructor(value, { response = 0.42, damping = 0.86 } = {}) {
    this.x = value; this.v = 0; this.target = value;
    this.k = (2 * Math.PI / response) ** 2; this.c = 4 * Math.PI * damping / response;
  }
  to(target, velocity) { this.target = target; if (velocity != null) this.v = velocity; wake(); }
  jump(value) { this.x = this.target = value; this.v = 0; }
  step(dtMs) {
    let dt = dtMs / 1000;
    while (dt > 0) {                     // small fixed steps keep it stable on slow frames
      const h = Math.min(dt, 1 / 240);
      this.v += (-this.k * (this.x - this.target) - this.c * this.v) * h;
      this.x += this.v * h;
      dt -= h;
    }
    const done = Math.abs(this.x - this.target) < 0.3 && Math.abs(this.v) < 3;
    if (done) { this.x = this.target; this.v = 0; }
    return !done;
  }
}
