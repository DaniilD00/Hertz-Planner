# Free car trips

A dark, interactive map of free one-way car trips ("relocation" trips) in Sweden and Norway, from three sites at once:

| Site | Colour on the map | What you get |
|---|---|---|
| [Hertz Freerider](https://www.hertzfreerider.se/sv-se/) | amber / yellow | Rental cars moved between Hertz stations. Station opening hours, key and parking instructions, return deadline, max distance and driving time. |
| [DriveBack](https://www.driveback.se/resor) | violet | Cars and vans moved between addresses. One car can go to several destinations (you pick one). Licence, age, deductible and deposit terms. Fuel included. |
| [Drive4Free](https://drive4free.io/) | teal | Trips between addresses or towns, matched by Drive4Free. Fuel and insurance included. |

## Reading the map

- **Colour** shows which site a trip is from. **Line style** shows when you can take it: solid and glowing = available now, dashed = opens within a day, dotted = opens later. Trips whose pickup window ends within 12 hours **pulse**.
- Thicker lines mean more cars on that route. Lines follow the fastest road once it has been looked up.
- **Direction:** small dark arrowheads along every line point the way the car goes. The trip you select has a soft light running along it from pick-up to drop-off, and with a trip plan it runs your whole journey.
- **Shades:** routes that overlap on the map get slightly different shades of their site's colour (for Hertz: amber, soft orange, golden and deep amber), so trips running side by side can be told apart while the map still reads as one colour. A route that overlaps nothing keeps the site's main colour, and the stripe in the list matches the line.
- Pick-up points are white dots ringed in the site's colour. Hertz gives exact coordinates; for DriveBack and Drive4Free the street address is looked up on the map, and the details panel says when a position is only approximate (for example when just the town is known).
- Click a road for every car on it: model, electric/hybrid/fuel, automatic or manual, van or estate, warnings like summer tyres, a timeline of the pickup window, and the site's terms. Click a station to see only the trips to and from it.
- The **Book** button opens the trip on the site it came from. DriveBack links go straight to that trip. Booking always happens on the site, with your own account. The map never books anything.

## Filters and alerts

- **Sites:** the coloured chips under the search boxes turn each site on or off and show how many cars it has. A dashed chip means that site didn't answer the last check (its last known trips are kept and a note at the top says from when).
- **When:** any time, now, today, tomorrow or this weekend. A car counts if its pickup window overlaps the time you pick.
- **More filters:** car type (electric, hybrid, petrol/diesel), automatic only, hide summer tyres, Sweden/Norway, and "I can leave between…".
- **Alerts (bell):** turn it on and the map notifies you when a new trip appears that matches your filters and trip plan. It checks every 3 minutes while the tab is open. If notifications are blocked, new trips show up as a message on the page and a count in the tab title.
- Trips that appeared since your last visit get a **New** badge.

## Plan a trip

Type where you are in **From** (or press the target button to use your current location), and optionally where you're going in **To**. Pick a suggestion: towns with pick-up points come first, then any address, station or place in Sweden, Norway, Denmark or Finland. Then set how far you're willing to travel with the slider.

| You fill in | You see |
|---|---|
| From only | Trips you can pick up within that distance of you, nearest first |
| To only | Trips that drop off within that distance of your destination |
| From and To | Trips **along your way**. You take a train or bus to the pick-up, drive the car, then continue. Both ends must be within the distance of your route, the car must take you forward and head your way (trips going back or sideways are left out), and trips are ranked by how many km of your journey the car covers. |

While your road is being looked up, a light runs from your start towards your destination; then the road draws itself in that direction and the area you're willing to travel in fades in around it: a faint band along the road (or a circle around a single place), worked out in real kilometres. Small chevrons on your road point the way.

The **⇅** button next to To swaps From and To, so you can check the same trip the other way round.

Clicking a trip shows **Your trip** as numbered steps, draws the train/bus legs as dotted lines, and links to Google Maps public-transport directions. Your plan and site choices are remembered next time. **Clear trip** removes the plan. If your system is set to reduce motion, everything appears without animation.

## Live version

The map also runs on GitHub Pages: **<https://daniild00.github.io/Hertz-planner/>**

GitHub Pages only hosts files, and the three sites don't let a web page read their trips directly, so a scheduled GitHub Action ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) does the server's job:

- About every 10 minutes (GitHub often starts scheduled runs a few minutes late) it runs [`scripts/snapshot.mjs`](scripts/snapshot.mjs), which uses the same site adapters as the local server to fetch the trips, look up addresses and road shapes, and write `data/trips.json` and `data/shapes.json`.
- It then builds the site without a server (`npm run build:pages`) and publishes it. Addresses, road shapes and each site's last good answer are kept between runs in the Actions cache, so each run only looks up what is new.
- In the browser, place search (Photon, with Nominatim as a backup) and the road for your trip plan (OSRM) are asked directly, since those services allow it.
- If a site doesn't answer, its trips from the last run are shown for up to a day, with the same note as the local version. If the update is more than 45 minutes late, the page says so. If every site fails, the map that's already live stays as it is.

The local version below checks the sites every 2.5 minutes, so it's still the quickest way to catch a new trip. To update the live map straight away, open the repo's **Actions** tab, pick **Update the map** and press **Run workflow**. GitHub pauses scheduled runs in a repo that has had no activity for 60 days; pressing **Enable workflow** on the same page starts them again.

## Run it (Windows)

1. Install [Node.js](https://nodejs.org/en/download) (the LTS version). This only has to be done once.
2. Double-click **`start.bat`**. A window opens with the server, and your browser opens the map at <http://localhost:3000>.
3. Close the window to stop the map.

With Node.js 20.13 or newer, the server restarts by itself when its files are updated, so an updated map works without closing the window: just reload the page.

## How it works

```
hertzfreerider.se  ─┐
driveback.se        ├─► local server (server/) ─► browser (MapLibre GL)
drive4free.io      ─┘     one common format, cached;
                          addresses and road shapes saved in cache/
```

- **Why a local server?** None of the sites allow other websites to read their data from the browser (no CORS headers), so the server fetches it and passes it on. Each site is asked at most every 2.5 minutes while the map is open (the refresh button asks again if the last answer is over 30 seconds old). If one site is slow or down, the others still show.
- **One format:** each site has a small adapter in `server/providers/` that turns its feed into the same stations and offers. Station ids carry the site (`hertz:SWJKG61`, `driveback:823`, `drive4free:halmstad`).
- **Times:** everything is shown in Swedish time. Hertz sends UTC without a `Z`; DriveBack sends Swedish wall-clock time *with* a `Z` (their own pages show `13:00:00Z` as 13:00); Drive4Free sends real UTC. `server/util.mjs` handles all three.
- **Addresses:** DriveBack and Drive4Free give street addresses (DriveBack also gives the town centre). Each address is looked up once with Photon (Nominatim as a backup), checked against the town so a same-named street elsewhere can't win, and saved in `cache/addresses.json`.
- **Counting cars:** one car can be listed for several destinations (Hertz's `transportOfferId`, DriveBack's destinations list). Booking one removes the others, so car counts use distinct cars and the details panel shows "also offered to…".
- **Roads:** every route is drawn along the fastest car route from OSRM, the routing engine behind OpenStreetMap's directions. Each pick-up→drop-off pair is looked up once and kept in `cache/geometry.json`. Lookups run one per second (the free servers' rule); available-now routes go first, and a route you click jumps the queue. Google's Directions API would need a paid key, and its terms don't allow showing or storing its routes on a non-Google map.

| File | What it does |
|---|---|
| `server/providers/*.mjs` | One adapter per site (fetch + convert to the common format) |
| `server/api.mjs` | The local API: trips from all sites, road-shape queue, place search |
| `server/geo.mjs` | Place search, address lookup and fastest-road routing, all cached |
| `server/geo-core.mjs` | Place search and routing helpers shared by the server and the browser |
| `server.mjs` | Serves the built site and the API (`npm start`) |
| `scripts/snapshot.mjs` | Makes `trips.json` and `shapes.json` for the GitHub Pages version |
| `.github/workflows/deploy.yml` | Updates and publishes the GitHub Pages version every 10 minutes |
| `src/providers.ts` | Each site's name, colours and wording |
| `src/normalize.ts` | Turns the feed into routes, cars and stations |
| `src/map.ts` | MapLibre layers, styling, hover and click, animations |
| `src/buffer.ts` | The "within R km of my road" area as a real polygon |
| `src/shades.ts` | Different shades for routes that overlap |
| `src/panel.ts` | Trip and station details |
| `src/list.ts` / `src/filters.ts` | Sidebar list, filters and sorting |

## Develop

```bash
npm install
npm run dev        # http://localhost:5173 with hot reload (the API runs inside Vite)
npm test           # unit tests: site adapters, times, car counting, trip planning, address lookup
npm run build      # type-check and build into dist/
npm start          # serve dist/ + the API on http://localhost:3000
npm run snapshot   # fetch the trips into dist/data/ (what the GitHub Action does)
npm run build:pages  # build the GitHub Pages version (no server; reads data/*.json)
```

## Notes

- The sites' feeds are public but unofficial and can change without notice. Each site's parsing is in its own file in `server/providers/`; if one breaks, the others keep working.
- The basemap is © OpenStreetMap contributors and © CARTO, free for non-commercial use. Road shapes and address lookups use free public OpenStreetMap services that aren't meant for heavy use, so this is a personal tool.
- Settings: `PORT` (default 3000), `OSRM_URL` (comma-separated OSRM-compatible servers to try in order).
- To re-draw every road from scratch, delete `cache/geometry.json`. To look addresses up again, delete `cache/addresses.json`.
