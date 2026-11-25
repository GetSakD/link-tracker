/* Everything that is a setting, a constant or a shared icon lives here. */
export const CFG = {
  base: window.OBA_BASE || 'https://api.pugetsound.onebusaway.org/api/where/',
  planner: window.PLAN_API || 'https://api.transitous.org/api/v1/',
  tz: 'America/Los_Angeles',
  route: '40_2LINE',
  otherLinkRoutes: ['40_2LINE', '40_100479'],          // Link rail routes, never shown as buses
  north: { lat: 47.8155, lon: -122.2950 },             // Lynnwood City Center, the 2 Line's north end
  styleLight: window.MAP_STYLE_LIGHT || 'https://tiles.openfreemap.org/styles/positron',
  styleDark: window.MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark',
  region: { s: 46.9, n: 48.3, w: -123.2, e: -121.6 },  // Puget Sound: place search stays inside this box
  busZoom: 14.5,                                       // bus stops appear from this zoom
  sideWidth: 360,                                      // corner panel width on wide screens
  follow: { zoom: 17, pitch: 50 },
  agencies: ['1', '40', '29', '3', '19', '97']         // Metro, Sound Transit, Community, Pierce, Intercity, Everett
};

export const COLORS = { bus: '#1A8597', walk: '#8E8E93', you: '#0A84FF', other: '#8E8E93', red: '#FF3B30' };

export const DIRS = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest' };

// other names people search for
export const STATION_ALIASES = [
  [/univ/i, 'university of washington uw husky stadium udub'], [/u district/i, 'university district udistrict uw'],
  [/int'?l dist|chinatown/i, 'international district chinatown id'], [/stadium/i, 'sodo stadium'], [/cap(itol)? hill/i, 'capitol hill'],
  [/westlake/i, 'downtown seattle'], [/bellevue downtown/i, 'downtown bellevue'], [/redmond technology/i, 'microsoft overlake'],
  [/spring district/i, 'spring district 120th'], [/wilburton/i, 'wilburton'], [/south bellevue/i, 'south bellevue park and ride']
];

const svg = (vb, body, attrs = '') => `<svg viewBox="${vb}" ${attrs} aria-hidden="true">${body}</svg>`;
export const ICON = {
  bus: svg('0 0 24 24', '<path d="M6 3h12a3 3 0 0 1 3 3v10a2 2 0 0 1-1 1.7V20a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H7v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2.3A2 2 0 0 1 3 16V6a3 3 0 0 1 3-3zm0 3v5h12V6H6zm1 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm10 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/>', 'width="16" height="16" fill="currentColor"'),
  walk: svg('0 0 24 24', '<circle cx="13" cy="4" r="2"/><path d="M14.5 7.5l-3 .2-3 3.3.9 1 2.3-1.8.6 3.4-2.8 4.4 1.3.9 3.1-4.2 1.4 1.6V21h1.6v-6.3l-1.9-2.3.4-2.6 1.4 1.6H19v-1.6h-2.1z"/>', 'width="14" height="14" fill="currentColor"'),
  locate: svg('0 0 24 24', '<path d="M20.6 3.4a.9.9 0 0 0-1-.2L3.7 10.1a.9.9 0 0 0 .1 1.7l6.6 1.8 1.8 6.6a.9.9 0 0 0 1.7.1l6.9-15.9a.9.9 0 0 0-.2-1z"/>', 'width="15" height="15" fill="currentColor"'),
  search: svg('0 0 24 24', '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', 'width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"'),
  pin: svg('0 0 24 24', '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>', 'width="13" height="13" fill="currentColor"'),
  dirs: svg('0 0 24 24', '<path d="M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/>', 'width="20" height="20" fill="currentColor"'),
  close: svg('0 0 12 12', '<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', 'width="12" height="12"'),
  chev: svg('0 0 8 13', '<path d="M1.5 1.5L6.5 6.5L1.5 11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>', 'class="chev"'),
  swap: svg('0 0 24 24', '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M21 16l-4 4-4-4"/>', 'width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'),
  clock: svg('0 0 12 12', '<circle cx="6" cy="6" r="4.6"/><path d="M6 3.6V6l1.6 1.2"/>', 'class="ck" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"'),
  live: svg('0 0 12 12', '<path d="M2 10a8 8 0 0 1 8-8"/><path d="M2 10a4 4 0 0 1 4-4"/>', 'class="rt"')
};
