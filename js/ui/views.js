/* Every screen of the panel, as a pure function of the state: S in, HTML out.
   main.js decides which one to show; morph() applies it without rebuilding what didn't change. */
import { ICON, DIRS } from '../config.js';
import { S, now } from '../state.js';
import { stationIdx, stationOfStop, hasTrip, lineOf, tripLines, transferFor, rideTo, canRide, tripUp, lineBadge, lineColor, lineText, lineName } from '../line.js';
import { nextTrain, yourTrain, upcoming, arrivalAt, unconfirmedBefore, whereText, tripKey, gpsFresh, rowFor } from '../trains.js';
import { trackedBus, nearbyStops } from '../buses.js';
import { selectedItinerary, firstRide, isRide, legMinutes, legColor, legText, legName } from '../plan.js';
import { fixText, busNumber, byRouteName, routeName } from '../api.js';
import * as P from './parts.js';
import { esc, clock, miles, dist, plural } from '../util.js';

export function where(v) {
  const w = whereText(v); if (!w) return '';
  return w.kind === 'at' ? `at <b>${esc(w.a)}</b>` : w.kind === 'between' ? `between <b>${esc(w.a)}</b> and <b>${esc(w.b)}</b>` : `near <b>${esc(w.a)}</b>`;
}

// a line's coloured square: 1, 2, T, N, S
export const badge = route => route ? `<span class="lbadge" style="background:${lineColor(route)};color:${lineText(route)}">${esc(lineBadge(route))}</span>` : '';
const lineList = ids => ids.map(lineName).filter(Boolean).join(' or ') || 'train';
// the far end of a line in the direction you're riding
const endOf = route => { const L = lineOf(route); return L?.stations.length ? (tripUp() ? L.stations.at(-1) : L.stations[0]).name : ''; };

// no single train goes there: say where to change
function transferCard() {
  const xf = transferFor();
  if (!xf) return `<div class="xfer">No train line connects <b>${esc(S.from)}</b> and <b>${esc(S.to)}</b>.<div class="acts"><button type="button" class="pri" data-act="dirs">Get directions</button></div></div>`;
  const L2 = lineOf(xf.second), i = stationIdx(xf.station, L2), j = stationIdx(S.to, L2);
  const toward = L2 && i >= 0 && j >= 0 ? (j > i ? L2.stations.at(-1) : L2.stations[0]).name : '';
  return `<div class="xfer">Change trains at <b>${esc(xf.station)}</b>: take the ${badge(xf.second)}<b>${esc(lineName(xf.second))}</b>${toward ? ' toward ' + esc(toward) : ''} to <b>${esc(S.to)}</b>.</div>`;
}

/* ---------------- trains ---------------- */
export function trainsView() {
  if (S.selected && S.trains[S.selected]) return trainDetail(S.trains[S.selected]);
  let html = '';
  const n = nextTrain(), y = yourTrain();
  if (S.line && !hasTrip()) html = P.intro('Choose your stations', 'Pick where you start and where you are going below.');
  else if (S.line && !canRide()) html = '<div class="drag-zone">' + transferCard() + '</div>';
  else if (!S.line || S.arr?.key !== tripKey()) html = '<div class="drag-zone">' + P.skeleton(2, 50) + '</div>';
  else if (!n) html = '<div class="drag-zone">' + P.empty(`No ${esc(lineList(tripLines()))} trains from ${esc(S.from)} toward ${esc(rideTo())} in the next 2 hours.`) + '</div>';
  else {
    const arrive = arrivalAt(n);
    let wh;
    const fresh = gpsFresh(y?.v);
    if (y?.v.cur) {
      const w = where(y.v);
      const atYours = whereText(y.v)?.kind === 'at' && whereText(y.v).a === S.from;   // waiting at your station to start your trip
      wh = y.prior ? (atYours ? `Your train is ${w}, getting ready to leave` : `Your train is finishing another trip, now ${w}`)
        : (fresh ? 'Your train is ' : 'Estimated: your train is ') + w + (n.stopsAway > 0 ? ' · ' + P.stopsAway(n.stopsAway) : '');
    } else if (y) wh = 'Finding your train on the map…';                  // known, just not placed yet (its track is loading)
    else wh = n.live ? "Your train hasn't started its trip yet." : 'No train is reporting for this trip yet. It may not come, so check back in a few minutes.';
    const ub = n.live ? unconfirmedBefore(n) : 0;
    if (ub) wh += `<br><small>${ub === 1 ? 'An earlier train is' : ub + ' earlier trains are'} on the timetable but not reporting, so it isn't counted.</small>`;
    html = `<div class="drag-zone"><div class="hero"><div class="count num${n.live ? ' live' : ''}">${P.countdown(n.t, true)}</div>` +
      `<div class="hero-info"><div class="hero-title">${badge(n.routeId)}To ${esc(rideTo())}</div><div class="hero-sub">${P.chip(n.dev, n.live)} <span class="num">${clock(n.t)}${arrive ? ' → ' + clock(arrive) : ''}</span></div></div></div>` +
      `<div class="where${fresh ? '' : ' est'}"><span class="pin"></span><span>${wh}</span>${y?.v.cur ? P.followBtn('follow', S.follow && !S.selected) : ''}</div>` +
      (transferFor() ? transferCard() : '') + '</div>';
  }
  html += alerts();
  html += P.section('Trip') + `<div class="trip-wrap"><div class="group trip">` +
    P.cell({ act: 'pick-from', ico: '<span class="dot-o"></span><span class="k">From</span>', text: esc(S.from || 'Choose a station'), right: ICON.chev }) +
    P.cell({ act: 'pick-to', ico: '<span class="dot-d"></span><span class="k">To</span>', text: esc(S.to || 'Choose a station'), right: ICON.chev }) +
    `</div><button class="swap" type="button" data-act="swap" aria-label="Swap direction">${ICON.swap}</button></div>`;
  const rows = upcoming();
  if (rows.length > 1) {
    const several = tripLines().length > 1;
    html += P.section('Departures', `<span class="plain">${esc(S.from)}</span>`) + '<div class="group">' + rows.slice(0, 7).map(x => {
      const ar = arrivalAt(x);
      // a train that stops short of its line's end says where it goes
      const term = endOf(x.routeId).split(' ')[0].toLowerCase();
      const shortTurn = x.headsign && term && !x.headsign.toLowerCase().includes(term) ? `<span class="to-tag">To ${esc(x.headsign)}</span>` : '';
      return `<div class="dep${x.canceled ? ' canceled' : ''}" data-key="${esc(x.tripId)}">${P.timeRow(x.t, ar ? 'Arrives ' + clock(ar) : '')}` +
        `<div class="m">${several ? badge(x.routeId) : ''}${P.chip(x.dev, x.live, x.canceled)}${shortTurn}</div><div class="mins num">${x.canceled ? '–' : P.countdown(x.t)}</div></div>`;
    }).join('') + '</div>';
  }
  return html + P.foot("Live positions from Sound Transit. Trains glide along the track between updates using each train's GPS and the timetable. Tap any train for its next stops.");
}

function alerts() {
  if (!S.alerts.length) return '';
  const al = S.alerts[0], mine = S.alerts.some(s => s.mine);
  return `<details class="alert${al.mine ? '' : ' other'}"${S.alertOpen ? ' open' : ''}><summary>${al.mine ? '⚠︎ ' : 'ⓘ '}${esc(fixText(al.summary.value))}${S.alerts.length > 1 ? ` (+${S.alerts.length - 1} more)` : ''}</summary>` +
    S.alerts.slice(0, 4).map(s => `<p>${s.mine || !mine ? '' : '<b>Elsewhere on the line: </b>'}${esc(fixText(s.description?.value || s.summary.value))}</p>`).join('') + '</details>';
}

function trainDetail(v) {
  const tt = S.trips[v.tripId];
  const fresh = gpsFresh(v);
  const sub = fresh ? 'Live GPS' + (v.gpsAt ? ` · updated <span data-ago="${v.gpsAt}"></span>` : '')
    : v.predicted && v.gpsAt ? `Estimated · last GPS <span data-ago="${v.gpsAt}"></span>` : 'Estimated from the timetable';
  const L = lineOf(v.route) || S.line;
  let html = P.header(`<div class="d-badge line" style="background:${lineColor(v.route)};color:${lineText(v.route)}">${esc(lineBadge(v.route) || '?')}</div>`, 'To ' + (v.headsign || ''), sub, 'close', 'Close',
    `<div class="where${fresh ? '' : ' est'}"><span class="pin"></span><span>${P.chip(v.dev, v.predicted)} ${fresh ? 'Now' : 'About'} ${where(v)}</span>${P.followBtn('follow', S.follow)}</div>`);
  html += P.section('Next stops');
  if (!tt) return html + `<div class="group">${P.empty("Loading this train's stops…")}</div>`;
  const tau = (now() - tt.sd) / 1000 - v.dev, a = stationIdx(S.from, L), b = stationIdx(S.to, L);
  // use the same time the Departures list shows for your station, and shift the other stops with it
  const row = rowFor(v.tripId), atA = a >= 0 ? tt.st.find(x => stationOfStop(x.id, L) === a) : null;
  const shift = row && atA ? Math.max(-300000, Math.min(300000, row.t - (tt.sd + (atA.d + v.dev) * 1000))) : 0;
  const rows = tt.st.filter(x => x.a + 20 >= tau).map(x => {
    const k = stationOfStop(x.id, L), name = k >= 0 ? L.stations[k].name : (S.stopInfo[x.id]?.name || 'Stop');
    const eta = x === atA && row ? row.t : tt.sd + (x.a + v.dev) * 1000 + shift;
    return `<div class="cell${k === a || k === b ? ' mine' : ''}" data-key="${esc(x.id)}"><span class="tl"></span><span class="v">${esc(name)}</span><span class="r num">${P.countdown(eta)} · ${clock(eta)}</span></div>`;
  }).join('');
  return html + `<div class="group stops">${rows || P.empty('This train has finished its trip.')}</div>` +
    P.foot(v.predicted ? "Times include this train's current delay." : "This train isn't sending GPS right now, so its position and times come from the timetable.");
}

/* ---------------- buses ---------------- */
export function busesView() {
  if (S.track) return trackView();
  const s = S.stop && S.stops[S.stop];
  return s ? stopView(s) : busesHome();
}

function busesHome() {
  let html = P.intro('Buses', 'Find any bus by route or bus number, or tap a stop on the map.') +
    `<form class="find" id="findForm" autocomplete="off">${ICON.search}<input id="findInput" type="search" enterkeyhint="search" placeholder="Find a bus: 545, 271, E, or bus #" aria-label="Find a bus by route or bus number"></form>` +
    '<div class="group" style="margin-top:12px">' + P.cell({ act: 'dirs', ico: `<span class="loc-ico muted-ico">${ICON.search}</span>`, text: 'Where to?', color: 'var(--label2)' }) + '</div>';
  if (!S.me) return html + P.section('&nbsp;') + '<div class="group">' + P.cell({ act: 'locate', ico: `<span class="loc-ico">${ICON.locate}</span>`, text: 'Show stops near me', color: 'var(--blue)' }) + '</div>';
  const near = nearbyStops(S.me);
  if (!near.length) return html + P.empty('Finding stops near you…');
  return html + P.section('Nearby') + '<div class="group">' + near.map(({ s, d }) =>
    P.cell({ attrs: `data-stop="${esc(s.id)}" data-key="${esc(s.id)}"`, cls: 'ind-40', ico: P.stopIcon(), text: esc(s.name),
      sub: `<span class="rbs">${s.routes.slice(0, 8).map(id => P.routeBadge(S.routes[id], true)).join('')}</span>`, right: `<span class="r num">${miles(d)}</span>` })).join('') + '</div>';
}

function stopView(s) {
  const meta = [DIRS[s.dir] || '', s.code ? 'Stop ' + s.code : '', S.me ? P.away(s) + ' away' : ''].filter(Boolean).join(' · ');
  let html = P.header(P.stopIcon(true), s.name, esc(meta), 'stop-close');
  if (S.stopArr?.id !== s.id) return html + P.skeleton(3, 58);
  const here = [...new Set(S.stopArr.list.map(x => x.routeId))].sort(byRouteName);
  if (S.routeFilter !== 'all' && !here.includes(S.routeFilter)) S.routeFilter = 'all';
  if (here.length > 1) html += `<div class="chips"><button type="button" data-route="all" aria-pressed="${S.routeFilter === 'all'}">All</button>` +
    here.map(id => `<button type="button" data-route="${esc(id)}" aria-pressed="${S.routeFilter === id}">${esc(routeName(S.routes[id]))}</button>`).join('') + '</div>';
  const list = S.stopArr.list.filter(x => S.routeFilter === 'all' || x.routeId === S.routeFilter).slice(0, 15);
  html += P.section('Next buses') + '<div class="group">' + (list.length ? list.map(x =>
    `<div class="bdep${x.canceled ? ' canceled' : ''}" data-key="${esc(x.tripId)}">${P.routeBadge(S.routes[x.routeId])}<div class="m"><div class="h">${esc(x.headsign)}</div>` +
    `<div class="s">${P.chip(x.dev, x.live, x.canceled)} ${x.live ? P.stopsAway(x.stopsAway) : ''}</div></div>` +
    `<div class="mins num">${x.canceled ? '–' : P.countdown(x.t)}<div>${clock(x.t)}</div></div></div>`).join('') : P.empty('No buses from this stop in the next 90 minutes.')) + '</div>';
  return html + P.foot('Buses heading to this stop are shown on the map. Live data from King County Metro, Community Transit and Sound Transit.');
}

function trackView() {
  const T = S.track, r0 = S.routes[T.routes[0]];
  const title = T.vehicleId && busNumber(T.vehicleId) ? 'Bus ' + busNumber(T.vehicleId) : r0 ? 'Route ' + routeName(r0) : `Find "${T.q}"`;
  const sub = T.loading ? 'Finding it live…' : T.err ? '' : plural(T.vehicles.length, 'bus', 'buses') + ' on the road now';
  let html = P.header(r0 ? P.routeBadge(r0) : P.stopIcon(true), title, sub, 'track-close', 'Stop tracking');
  if (T.loading) return html + P.skeleton(2, 64);
  if (T.err) return html + P.empty(esc(T.err) + ' Try a route like 545, a letter like E, or the 4-digit number on the bus.');
  if (!T.vehicles.length) return html + P.empty(T.routes.every(id => id.startsWith('29_'))
    ? "Community Transit doesn't share where its buses are with OneBusAway, so they can't be shown on the map. Arrival times at its stops are still live."
    : 'No live buses on this route right now. It may not be running at this hour.');
  const sv = trackedBus();
  if (sv) {
    const nx = S.stopInfo[sv.next]?.name, nr = S.stopInfo[sv.near]?.name;
    html += `<div class="ride"><div class="ride-top"><div class="ride-h">To ${esc(sv.headsign || '…')}</div>${P.followBtn('track-follow', T.follow)}</div>` +
      `<div class="ride-l">${P.chip(Math.round(sv.dev / 60) * 60, true)}${busNumber(sv.vehicleId) ? ` <span class="muted">Bus ${esc(busNumber(sv.vehicleId))}</span>` : ''}` +
      (nr ? `<br>Near <b>${esc(nr)}</b>` : '') + (nx && nx !== nr ? `<br>Next stop <b>${esc(nx)}</b>` : '') +
      (S.me ? `<br>${P.away(sv.pos)} from you` : '') + (sv.at ? `<br><span class="muted">GPS updated <span data-ago="${sv.at}"></span></span>` : '') + '</div></div>';
    if (!T.vehicleId && T.vehicles.length > 1) html += '<div class="group" style="margin-top:10px">' + P.cell({ act: 'track-all', text: `Show all ${T.vehicles.length} buses`, color: 'var(--blue)' }) + '</div>';
    return html + P.foot(`Tilt the map with two fingers to see it in 3D. Live GPS from the transit agency, updated every ${S.refreshSec} s.`);
  }
  return html + P.section('Tap a bus to follow it') + '<div class="group">' + T.vehicles.slice(0, 30).map(v => {
    const nr = S.stopInfo[v.near]?.name || S.stopInfo[v.next]?.name;
    return `<button class="bdep" type="button" data-veh="${esc(v.tripId)}" data-key="${esc(v.tripId)}">${P.routeBadge(S.routes[v.routeId])}` +
      `<div class="m"><div class="h">To ${esc(v.headsign || '…')}</div><div class="s">${P.chip(Math.round(v.dev / 60) * 60, true)}${nr ? ' near ' + esc(nr) : ''}</div></div>` +
      `<div class="mins num small">${P.away(v.pos)}<div>${busNumber(v.vehicleId) ? 'Bus ' + esc(busNumber(v.vehicleId)) : 'Bus'}</div></div></button>`;
  }).join('') + '</div>';
}

/* ---------------- directions ---------------- */
const legBadge = (l, small) => P.badge(legName(l), legColor(l), legText(l), small);
const placeName = p => !p || p.name === 'START' ? (S.plan.from || 'your location') : p.name === 'END' ? S.plan.to : p.name;

function rideCard() {
  const l = firstRide(); if (!l) return '';
  const v = l.live, st = l.stop, kind = l.mode === 'BUS' ? 'bus' : 'train';
  const meta = [st?.code ? 'Stop ' + st.code : '', DIRS[st?.dir] || ''].filter(Boolean);
  let lines;
  if (v === undefined) lines = `Finding your ${kind} live…`;
  else if (!v) lines = `No live signal for this ${kind} yet. It's scheduled to leave at <b>${clock(Date.parse(l.startTime))}</b>.`;
  else if (v.canceled) lines = '<span class="text-red">This trip is canceled.</span> Pick another route above.';
  else {
    const whereNow = v.pos ? (v.stopsAway > 0 ? P.stopsAway(v.stopsAway) : 'arriving now') + (v.near ? `, near <b>${esc(v.near)}</b>` : '') + ` (${miles(dist(v.pos, st || l.from))})` : 'not on the road yet';
    lines = `Your <b>${esc(legName(l))}</b> is ${whereNow}. ${P.chip(v.dev, v.live)}<br>Reaches your stop in <b>${P.countdown(v.t)}</b> · ${clock(v.t)}`;
  }
  return `<div class="ride"><div class="ride-top">${legBadge(l)}<div class="ride-h">Your next ${kind}</div>${v?.pos ? P.followBtn('plan-follow', S.follow) : ''}</div>` +
    `<div class="ride-l">${lines}</div><div class="ride-w">${P.stopIcon()}<div><b>Wait at ${esc(st ? st.name : l.from.name)}</b>` +
    (meta.length ? `<small>${esc(meta.join(' · '))}</small>` : '') + (S.me ? `<small>${P.away(st || l.from)} from you</small>` : '') + '</div></div></div>';
}
function liveLine(l) {
  const v = l.live;
  if (v === undefined) return '<span class="chip sched">Checking live…</span>';
  if (!v) return `<span class="chip sched">${ICON.clock}Scheduled</span>`;
  if (v.canceled) return '<span class="chip cancel">Canceled</span>';
  return [P.chip(v.dev, v.live), v.live && v.stopsAway > 0 ? P.stopsAway(v.stopsAway) : !v.pos ? 'not on the road yet' : '', 'departs ' + clock(v.t)].filter(Boolean).join(' · ');
}
const legChain = it => it.legs.map(l => isRide(l) ? legBadge(l, true) : legMinutes(l) < 2 && it.legs.length > 1 ? '' : `<span class="wk">${ICON.walk}${legMinutes(l)}</span>`).filter(Boolean).join('<span aria-hidden="true">›</span>');

export function planView() {
  const PL = S.plan;
  let html = P.header(`<div class="d-badge blue">${ICON.dirs}</div>`, 'To ' + PL.to, 'From ' + esc(PL.from), 'plan-close', 'Close directions');
  if (PL.loading) return html + P.skeleton(2, 84);
  if (PL.err) return html + P.empty(esc(PL.err));
  const modes = `<div class="chips plan-modes" role="group" aria-label="Travel mode"><button type="button" data-act="plan-mode" data-m="all" aria-pressed="${PL.mode !== 'bus'}">Bus &amp; train</button><button type="button" data-act="plan-mode" data-m="bus" aria-pressed="${PL.mode === 'bus'}">Bus only</button></div>`;
  if (!PL.its.length) return html + modes + P.empty('No trips found right now.') + '<div class="group">' + P.cell({ act: 'plan-edit', text: 'Change trip', color: 'var(--blue)' }) + '</div>';
  const fastest = Math.min(...PL.its.map(o => o.duration)), fewest = Math.min(...PL.its.map(o => o.transfers));
  const fewestOnly = PL.its.filter(o => o.transfers === fewest).length === 1;
  html += modes + rideCard() + P.section('Routes', '<button type="button" data-act="plan-edit" class="link">Edit</button>') + '<div class="group">' + PL.its.map((it, i) => {
    const first = it.legs.find(isRide);
    const tag = it.duration === fastest ? '<span class="best">Fastest</span>' : fewestOnly && it.transfers === fewest ? '<span class="best alt">Fewest transfers</span>' : '';
    return `<button class="it${i === PL.sel ? ' on' : ''}" type="button" data-it="${i}" data-key="it${i}"><div class="row1"><span class="dur num">${Math.round(it.duration / 60)} min${tag}</span>` +
      `<span class="tt num">${clock(Date.parse(it.startTime))} – ${clock(Date.parse(it.endTime))}</span></div><div class="legs">${legChain(it)}</div>` +
      `<div class="sub">${first ? `Board ${esc(first.routeShortName || 'at')} at ${esc(first.from.name)} · ${clock(Date.parse(first.startTime))}` : 'Walk the whole way'}${it.transfers ? ' · ' + plural(it.transfers, 'transfer') : ''}</div></button>`;
  }).join('') + '</div>';
  const it = selectedItinerary();
  if (it) {
    html += P.section('Steps') + '<div class="group">' + it.legs.map(l => {
      if (!isRide(l)) return legMinutes(l) < 2 && it.legs.length > 1 ? '' :
        `<div class="step"><div class="ic"><span class="walk-ico">${ICON.walk}</span></div><div class="tx">Walk to ${esc(placeName(l.to))}<small>${legMinutes(l)} min</small></div><div class="tm num">${clock(Date.parse(l.startTime))}</div></div>`;
      const n = (l.intermediateStops || []).length + 1;
      return `<div class="step"><div class="ic">${legBadge(l, true)}</div><div class="tx">Take ${esc(legName(l))}${l.headsign ? ' toward ' + esc(l.headsign) : ''}` +
        `<small class="live-line">${liveLine(l)}</small><small>Board at ${esc(l.from.name)} · ride ${plural(n, 'stop')} (${legMinutes(l)} min)<br>Get off at ${esc(l.to.name)} · ${clock(Date.parse(l.endTime))}</small></div>` +
        `<div class="tm num">${clock(Date.parse(l.startTime))}</div></div>`;
    }).join('') + `<div class="step"><div class="ic"><span class="walk-ico end">●</span></div><div class="tx">Arrive at ${esc(PL.to)}</div><div class="tm num">${clock(Date.parse(it.endTime))}</div></div></div>`;
  }
  return html + P.foot('Routes are planned with the official timetables by Transitous, a free open trip planner. Live times come from the transit agencies.');
}
