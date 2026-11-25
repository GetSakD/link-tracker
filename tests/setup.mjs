// Just enough of a browser for the app's logic modules to load in Node.
const mem = {};
globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, visibilityState: 'visible', querySelector: () => null };
globalThis.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 16);
// the app's background timers (status ticks, retries) shouldn't keep the test run open
const si = globalThis.setInterval, st = globalThis.setTimeout;
globalThis.setInterval = (fn, ms, ...a) => { const t = si(fn, ms, ...a); t.unref?.(); return t; };
globalThis.setTimeout = (fn, ms, ...a) => { const t = st(fn, ms, ...a); if (ms > 5000) t.unref?.(); return t; };
