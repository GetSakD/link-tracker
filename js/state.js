/* The app's single source of truth, plus a tiny event bus.
   Data modules change S and call changed(); views subscribe and redraw once per frame. */
import { store } from './util.js';

export const S = {
  // settings
  key: store.get('key', 'TEST'),
  refreshSec: store.get('refreshSec', 15),
  mode: store.get('mode', 'trains'),             // 'trains' | 'buses'
  from: store.get('from', null), to: store.get('to', null),
  // data from Sound Transit
  line: null,          // stations, platforms, track shapes
  trips: {},           // tripId -> timetable
  stopInfo: {},        // stopId -> { name, lat, lon }
  routes: {},          // routeId -> route
  trains: {},          // tripId -> live train
  arr: null,           // departures from your station
  alerts: [],
  // buses
  stops: {},           // stopId -> nearby bus stop
  stop: null,          // selected stop id
  stopArr: null,       // its departures
  routeFilter: 'all',
  track: null,         // a bus you searched for / follow
  plan: null,          // directions
  // view
  view: 'map', detent: 'peek', selected: null, follow: false, alertOpen: false, pickDismissed: false, noMap: false,
  me: null,
  // health
  clockOffset: 0, lastOk: 0, okCalls: 0, err: null, keyBad: false
};

export const now = () => Date.now() + S.clockOffset;

const subs = {};
export function on(evt, fn) { (subs[evt] = subs[evt] || []).push(fn); }
export function emit(evt, arg) { (subs[evt] || []).forEach(fn => fn(arg)); }

/* changed(): something visible changed. Many calls in one frame become one redraw. */
let queued = false;
export function changed() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; emit('render'); });
}
