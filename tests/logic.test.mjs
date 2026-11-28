/* Tests for the logic that decides which trains and buses you see, and when.
   Run: npm test */
import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { S } = await import('../js/state.js');
const { parseDeparture, busNumber, passedStop, vehicleFrom, departures, indexRefs } = await import('../js/api.js');
const LN = await import('../js/line.js');
const { mainShape } = LN;
const T = await import('../js/trains.js');
const { project } = await import('../js/util.js');

/* A straight test line running north: stations A..E, about 2.8 km apart. North is "up" (toward Lynnwood). */
const names = ['A', 'B', 'C', 'D', 'E'], lat = i => 47.60 + i * 0.025, LON = -122.30;
function setLine() {
  const stations = names.map((name, i) => ({ name, up: 'U' + i, down: 'D' + i, lat: lat(i), lon: LON }));
  const stopIdx = {}; stations.forEach((s, i) => { stopIdx[s.up] = i; stopIdx[s.down] = i; });
  S.shapes = { UP: { pts: Array.from({ length: 41 }, (_, k) => [47.60 + k * 0.0025, LON]) } };
  S.line = { route: 'R1', name: '1 Line', stations, stopIdx, shapes: {}, shapeUp: 'UP', shapeDown: 'UP', dirUp: '1', dirDown: '0' };
  S.lines = { R1: S.line }; S.lineOrder = ['R1'];
  stations.forEach(s => { s.s = project(mainShape(), s).s; });
}
const NOW = Date.now();
// a timetable for a northbound trip starting at A at `start` (ms), 3 minutes between stations
function timetable(id, start, next = null) {
  const sd = start - (start % 86400000);
  S.trips[id] = { sd, next, route: 'R1', shapeId: 'UP', dirId: '1', st: names.map((n, i) => ({ id: 'U' + i, a: (start - sd) / 1000 + i * 180, d: (start - sd) / 1000 + i * 180 + 20, s: i * 2780 })) };
}
function reset() {
  setLine(); S.from = 'B'; S.to = 'D'; S.trips = {}; S.trains = {}; S.clockOffset = 0;
  S.arr = { key: T.tripKey(), at: NOW, list: [] };
}
const row = (o) => ({ tripId: 'X', routeId: 'R1', t: NOW + 5 * 60000, sched: NOW + 5 * 60000, live: true, dev: 0, dirId: '1', canceled: false, dup: false, departs: true, blockLive: false, stopsAway: 2, distFromStop: 4000, gps: true, ...o });
const train = (tripId, atLat, o = {}) => ({ tripId, route: 'R1', dirId: '1', predicted: true, gps: { lat: atLat, lon: LON }, gpsAt: NOW - 20000, cur: { lat: atLat, lon: LON }, ...o });

/* ---------- reading the feed ---------- */
test('a timetable placeholder bus has no GPS and no fleet number', () => {
  const refs = indexRefs({});
  const fake = parseDeparture({ tripId: 't', routeId: '1_49', predicted: true, predictedDepartureTime: NOW + 60000, scheduledDepartureTime: NOW,
    tripStatus: { vehicleId: '1_8296431', predicted: true, activeTripId: 't', lastLocationUpdateTime: 0 } }, refs);
  const real = parseDeparture({ tripId: 't', routeId: '1_49', predicted: true, predictedDepartureTime: NOW + 60000, scheduledDepartureTime: NOW,
    tripStatus: { vehicleId: '1_8208', predicted: true, activeTripId: 't', lastLocationUpdateTime: NOW - 30000, lastKnownLocation: { lat: 47.6, lon: -122.3 } } }, refs);
  assert.equal(fake.gps, false);
  assert.equal(real.gps, true);
  assert.equal(busNumber('1_8296431'), '');
  assert.equal(busNumber('1_8208'), '8208');
  assert.equal(busNumber('40_568.934164'), '');
});

test('a vehicle on the trip before this one counts as on its way', () => {
  const x = parseDeparture({ tripId: 'next', routeId: '40_2LINE', predicted: false, scheduledDepartureTime: NOW, tripStatus: { predicted: true, activeTripId: 'before' } }, indexRefs({}));
  assert.equal(x.live, false);
  assert.equal(x.blockLive, true);
});

test('waiting at the first stop with a known delay counts as live', () => {
  const x = parseDeparture({ tripId: 't', routeId: '1_49', predicted: false, scheduledDepartureTime: NOW, tripStatus: { predicted: true, activeTripId: 't', scheduleDeviation: 120 } }, indexRefs({}));
  assert.equal(x.live, true);
  assert.equal(x.t, NOW + 120000);
});

test('the feed saying a vehicle is past the stop removes it', () => {
  assert.equal(passedStop({ stopsAway: -1, distFromStop: -537, live: true }), true);
  assert.equal(passedStop({ stopsAway: 0, distFromStop: 1709, live: true }), false);
});

test('buses without GPS, or with GPS older than 5 minutes, are not drawn', () => {
  const refs = indexRefs({ trips: [{ id: 't', routeId: '1_49' }] });
  assert.equal(vehicleFrom('t', { predicted: true, position: { lat: 47.6, lon: -122.3 }, vehicleId: '1_8296431', lastLocationUpdateTime: 0 }, refs), null);
  assert.equal(vehicleFrom('t', { predicted: true, position: { lat: 47.6, lon: -122.3 }, vehicleId: '1_8208', lastLocationUpdateTime: NOW - 6 * 60000, lastKnownLocation: { lat: 47.6, lon: -122.3 } }, refs), null);
  assert.ok(vehicleFrom('t', { predicted: true, position: { lat: 47.6, lon: -122.3 }, vehicleId: '1_8208', lastLocationUpdateTime: NOW - 30000, lastKnownLocation: { lat: 47.6, lon: -122.3 } }, refs));
});

test('one row per trip: the real bus wins over its placeholder, and passed rows are dropped', async () => {
  S.key = 'MYKEY';
  const ad = [
    { tripId: 'A', routeId: '1_49', predicted: true, predictedDepartureTime: NOW + 60000, scheduledDepartureTime: NOW, tripStatus: { vehicleId: '1_8296451', predicted: true, activeTripId: 'A' } },
    { tripId: 'A', routeId: '1_49', predicted: true, predictedDepartureTime: NOW + 50000, scheduledDepartureTime: NOW, tripStatus: { vehicleId: '1_4318', predicted: true, activeTripId: 'A', lastLocationUpdateTime: NOW - 20000 } },
    { tripId: 'B', routeId: '1_49', predicted: true, predictedDepartureTime: NOW - 20000, scheduledDepartureTime: NOW, numberOfStopsAway: -1, distanceFromStop: -300, tripStatus: { predicted: true, activeTripId: 'B', lastLocationUpdateTime: NOW } }
  ];
  globalThis.fetch = async () => ({ status: 200, text: async () => JSON.stringify({ code: 200, currentTime: Date.now(), data: { entry: { arrivalsAndDepartures: ad }, references: {} } }) });
  const { rows } = await departures('1_1', 30);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vehicleId, '1_4318');
});

/* ---------- which trains you see ---------- */
test('a timetable-only trip whose start time has passed is a ghost and is hidden', () => {
  reset();
  timetable('ghost', NOW - 10 * 60000);
  S.arr.list = [row({ tripId: 'ghost', live: false, gps: false })];
  assert.equal(T.isGhost(S.arr.list[0]), true);
  assert.deepEqual(T.upcoming(), []);
});

test('a ghost is found even before its timetable has loaded, using another trip\'s running time', () => {
  reset();
  timetable('other', NOW - 60 * 60000);
  // at B (one stop from the start) in 1 minute: the trip should have left A 2 minutes ago
  const x = row({ tripId: 'noTT', live: false, gps: false, t: NOW + 60000, sched: NOW + 60000 });
  S.arr.list = [x];
  assert.equal(T.isGhost(x), true);
});

test('a timetable-only trip that has not started yet is still shown', () => {
  reset();
  timetable('later', NOW + 20 * 60000);
  const x = row({ tripId: 'later', live: false, gps: false, t: NOW + 23 * 60000 });
  S.arr.list = [x];
  assert.equal(T.isGhost(x), false);
  assert.equal(T.upcoming().length, 1);
});

test('a trip whose train is finishing the trip before it is not a ghost', () => {
  reset();
  timetable('prev', NOW - 30 * 60000, 'mine');
  timetable('mine', NOW - 2 * 60000);
  S.trains.prev = train('prev', lat(4));
  const x = row({ tripId: 'mine', live: false });
  assert.equal(T.isGhost(x), false);
  assert.equal(T.trainFor(x).prior, true);
});

test('a train already past your station is gone, even if its time has not come', () => {
  reset();
  S.trains.T1 = train('T1', lat(1) + 0.004);            // ~440 m north of B, heading north
  const x = row({ tripId: 'T1', t: NOW + 30000 });
  assert.equal(T.trainPassed(x), true);
  assert.equal(T.isGone(x), true);
});

test('a late train still approaching your station stays, even after its time', () => {
  reset();
  S.trains.T1 = train('T1', lat(1) - 0.004);            // ~440 m south of B
  const x = row({ tripId: 'T1', t: NOW - 60000 });
  assert.equal(T.isGone(x), false);
});

test('with no train position, a row goes 30 s after its time; nothing lasts past 3 minutes', () => {
  reset();
  assert.equal(T.isGone(row({ tripId: 'none', t: NOW - 20000 })), false);
  assert.equal(T.isGone(row({ tripId: 'none', t: NOW - 40000 })), true);
  S.trains.T1 = train('T1', lat(1) - 0.004);
  assert.equal(T.isGone(row({ tripId: 'T1', t: NOW - 4 * 60000 })), true);
});

test('the big countdown and the list use the same rule', () => {
  reset();
  timetable('ghost', NOW - 10 * 60000);
  S.trains.T2 = train('T2', lat(0) + 0.01);
  S.arr.list = [row({ tripId: 'ghost', live: false, gps: false, t: NOW + 60000 }), row({ tripId: 'T2', t: NOW + 4 * 60000 })];
  assert.deepEqual(T.upcoming().map(x => x.tripId), ['T2']);
  assert.equal(T.nextTrain().tripId, 'T2');
});

test('GPS older than 3 minutes is treated as an estimate', () => {
  assert.equal(T.gpsFresh(train('a', 47.6, { gpsAt: NOW - 60000 })), true);
  assert.equal(T.gpsFresh(train('a', 47.6, { gpsAt: NOW - 4 * 60000 })), false);
  assert.equal(T.gpsFresh(train('a', 47.6, { predicted: false })), false);
});

/* ---------- several lines ---------- */
// a second line sharing B..E with the first, branching off east from B: B, X, Y
function addBranch() {
  const st = [['Y', 47.62, -122.20], ['X', 47.623, -122.25], ['B', lat(1), LON], ['C', lat(2), LON], ['D', lat(3), LON], ['E', lat(4), LON]]
    .map(([name, la, lo], i) => ({ name, lat: la, lon: lo, up: i < 2 ? 'V' + i : 'U' + (i - 1), down: i < 2 ? 'W' + i : 'D' + (i - 1) }));
  const stopIdx = {}; st.forEach((s, i) => { stopIdx[s.up] = i; stopIdx[s.down] = i; });
  S.shapes.UP2 = { pts: st.map(s => [s.lat, s.lon]) };
  S.lines.R2 = { route: 'R2', name: '2 Line', stations: st, stopIdx, shapes: {}, shapeUp: 'UP2', shapeDown: 'UP2', dirUp: '0', dirDown: '1' };
  S.lineOrder = ['R1', 'R2'];
  st.forEach(s => { s.s = project(mainShape(S.lines.R2), s).s; });
}

test('where two lines share track, a trip can take either', () => {
  reset(); addBranch();
  S.from = 'B'; S.to = 'D';
  assert.deepEqual(LN.tripLines(), ['R1', 'R2']);
  assert.equal(LN.transferFor(), null);
  assert.equal(LN.rideTo(), 'D');
});

test('a trip with no single line says where to change trains', () => {
  reset(); addBranch();
  S.from = 'A'; S.to = 'X';                        // A is only on R1, X only on R2: change at B
  assert.deepEqual(LN.directLines(), []);
  const xf = LN.transferFor();
  assert.equal(xf.station, 'B'); assert.equal(xf.first, 'R1'); assert.equal(xf.second, 'R2');
  assert.equal(LN.rideTo(), 'B');                  // the countdown is for the first train, to B
  assert.deepEqual(LN.tripLines(), ['R1']);
});

test("each line keeps its own direction ids", () => {
  reset(); addBranch();
  assert.equal(LN.isUp('1', 'R1'), true);
  assert.equal(LN.isUp('1', 'R2'), false);         // on R2, '0' is northbound
  assert.equal(LN.isUp('0', 'R2'), true);
});

test('every station is listed once, with all the lines that stop there', () => {
  reset(); addBranch();
  const all = LN.allStations(), b = all.find(s => s.name === 'B');
  assert.equal(all.length, 7);
  assert.deepEqual(b.lines, ['R1', 'R2']);
  assert.equal(LN.lineBadge('R2'), '2');
});
