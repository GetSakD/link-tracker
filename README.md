# Link Tracker

Live 2 Line train positions between Downtown Redmond and Lynnwood City Center, from Sound Transit's real-time feed (OneBusAway Puget Sound).

Open `index.html` from GitHub Pages and add it to your iPhone home screen.


## How the code is organized

The app is plain JavaScript modules, no build step. Data flows one way: `refresh()` pulls from the
feeds into one state object (`S`), `changed()` schedules one redraw per frame, and a single
animation loop moves trains, buses and the camera.

| File | What it does |
| --- | --- |
| `js/main.js` | Starts the app, refreshes data, handles taps |
| `js/state.js` | The single state object and a tiny event bus |
| `js/loop.js` | One animation loop that sleeps when nothing moves; spring physics |
| `js/api.js` | OneBusAway requests (one rate-limited queue) and shared parsers |
| `js/line.js` | 2 Line stations, platforms, track shapes, timetables |
| `js/trains.js` | Live trains, departures, "your train" |
| `js/buses.js`, `js/fleet.js` | Bus stops, finding a bus, and road-following bus motion |
| `js/plan.js` | Directions (Transitous) matched to live vehicles |
| `js/motion.js` | How vehicles glide: continuous position and speed, never backwards |
| `js/map/` | MapLibre layers, icons, camera and follow mode |
| `js/ui/` | Panel screens (pure functions of state), DOM patching, the spring sheet, panels |
| `css/app.css` | All styles |

## Train lines

The app finds Sound Transit's train lines (1 Line, 2 Line, T Line, Sounder) from OneBusAway at startup, so new lines show up by themselves. Where lines share track (the 1 and 2 Lines between Lynnwood and International District), departures from both are merged. Trips that need a change of trains count down to the first train and say where to change.

## Tests

`npm test` (or `node --test tests/*.test.mjs`) checks the rules that decide what you see:
ghost trips, trains that already left, one shared cutoff for the countdown and the list,
stale GPS shown as an estimate, and King County's no-GPS placeholder buses.
