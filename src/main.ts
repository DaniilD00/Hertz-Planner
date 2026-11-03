import './styles.css';
import { STATIC, fetchGeometry, fetchPlanRoute, fetchRoutes } from './api';
import { h, plural } from './dom';
import { applyFilters, defaultFilters, type Filters } from './filters';
import { fmtTime, fmtWhen } from './format';
import { decodePolyline, geoKey, lineFor, type Shapes } from './geometry';
import { buildRoute, circlePolygon, haversineKm, makeMatcher, planMode, type PlanMatch, type PlanRoute } from './plan';
import { PROVIDERS, PROVIDER_ORDER } from './providers';
import { Sidebar } from './list';
import { TripMap } from './map';
import { normalize } from './normalize';
import { renderCorridorPanel, renderStationPanel } from './panel';
import { assignShades } from './shades';
import type { Corridor, Model, ProviderId, ProviderStatus, RoutesResponse, Station } from './types';

const REFRESH_MS = 3 * 60 * 1000;
const TICK_MS = 60 * 1000;
const SEEN_KEY = 'free-car-trips.seen.v2';
const OLD_SEEN_KEY = 'hertz-planner.seen-routes';
const ALERTS_KEY = 'free-car-trips.alerts';
const APP_TITLE = 'Free car trips';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const sidebarEl = $('sidebar');
const panelEl = $('panel');
const bannerEl = $('banner');
const roadsEl = $('roads');
const toastEl = $('toast');

// Each site's colours as CSS variables (--p, --p-soon, --p-later, --p-ink) on anything marked data-provider,
// generated from the same table the map uses so the two can't drift apart.
document.head.append(
  h(
    'style',
    null,
    PROVIDER_ORDER.map((id) => {
      const c = PROVIDERS[id].colors;
      return `[data-provider="${id}"]{--p:${c.now};--p-soon:${c.soon};--p-later:${c.later};--p-ink:${c.ink}}`;
    }).join('\n'),
  ),
);

const state = {
  feed: null as RoutesResponse | null,
  model: null as Model | null,
  fetchedAt: null as Date | null,
  lastLoad: 0,
  shapes: {} as Shapes,
  roads: new Map<string, { km?: number; min?: number }>(),
  shades: new Map<string, number>(), // route id → shade of its site's colour (overlapping routes differ)
  filters: defaultFilters() as Filters,
  selected: null as string | null,
  focusStation: null as string | null,
  visible: [] as Corridor[],
  matches: new Map<string, PlanMatch>(),
  planRoute: null as PlanRoute | null,
  planRouteKey: '',
  planRouteState: 'idle' as 'idle' | 'loading' | 'failed',
  newRouteIds: new Set<string>(),
  prevIds: {} as Partial<Record<ProviderId, Set<string>>>,
  autoFit: true,
  alerts: readAlerts(),
  unseenAlerts: 0,
};

const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

const tripMap = new TripMap($('map'), $('tooltip'), {
  onSelectCorridor: (id) => selectCorridor(id),
  onSelectStation: (code) => selectStation(code),
  onClearSelection: () => closePanel(),
  onHoverCorridor: (id) => sidebar.highlight(id),
  onBasemapFailed: () => setBanner('basemap', 'The dark background map couldn’t load, so only the trips are drawn. Check your internet connection and reload the page.'),
});
// Once you move the map yourself, it stops re-centring when more trips arrive
tripMap.map.on('movestart', (e) => {
  if ((e as { originalEvent?: Event }).originalEvent) state.autoFit = false;
});

const sidebar = new Sidebar(sidebarEl, {
  onFiltersChange: (f) => {
    state.filters = f;
    render();
  },
  onSelect: (id) => selectCorridor(id),
  onHover: (id) => tripMap.hover(id),
  onRefresh: () => void load(true),
  onClearFocus: () => {
    if (!state.focusStation) return;
    state.focusStation = null;
    closePanel();
  },
  onPlanPlacesChange: () => {
    void updatePlanRoute();
    fitPlan();
  },
  onToggleAlerts: () => void toggleAlerts(),
});
state.filters = sidebar.current(); // a trip plan remembered from last time applies straight away
sidebar.setAlerts(state.alerts);
void updatePlanRoute();

renderLegend($('legend'));
updatePadding();
window.addEventListener('resize', updatePadding);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  tripMap.closeChooser();
  if (!panelEl.hidden) closePanel();
});

// ---------- data ----------

let loadingTimer = 0;
let loading = false;

async function load(fresh = false) {
  if (loading) return;
  loading = true;
  clearTimeout(loadingTimer);
  sidebar.setLoading(true);
  try {
    const res = await fetchRoutes(fresh);
    if (!Array.isArray(res.offers) || !Array.isArray(res.providers)) {
      throw new Error('The map’s server is an older version. Close its window and start it again with start.bat.');
    }
    state.feed = res;
    state.fetchedAt = new Date(res.fetchedAt);
    state.lastLoad = Date.now();
    setBanner('load', null);
    recompute();
    const appeared = trackNewTrips(res);
    sidebar.setProviders(res.providers);
    setBanner('sites', sitesBanner(res.providers));
    setBanner('late', lateBanner(res.snapshotAt));
    await tripMap.whenReady();
    render();
    const stillLoading = res.providers.some((p) => p.loading);
    if (state.autoFit && state.model && state.model.stations.size && !state.selected && !state.focusStation) {
      if (planMode(state.filters.fromPlace, state.filters.toPlace)) fitPlan();
      else tripMap.fitStations([...state.model.stations.values()], 6.5);
      if (!stillLoading) state.autoFit = false;
    }
    if (appeared.length) alertNew(appeared);
    void pollGeometry();
    // A site that hasn't answered yet usually does within seconds: ask again soon rather than in 3 minutes
    if (stillLoading) loadingTimer = window.setTimeout(() => void load(), 3000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (state.model && state.fetchedAt) {
      setBanner('load', `Couldn’t refresh: ${msg} Showing trips from ${fmtTime(state.fetchedAt)}.`);
    } else {
      setBanner(
        'load',
        STATIC ? `Couldn’t load trips. ${msg} Check your internet connection, then press refresh.` : `Couldn’t load trips. ${msg} Check that the map’s window is still open, then press refresh.`,
      );
      sidebar.showError('No trips loaded yet.');
    }
  } finally {
    loading = false;
    sidebar.setLoading(false);
  }
}

/** Re-derive statuses from the feed (cars become available, and offers end, as time passes). */
function recompute() {
  if (!state.feed) return;
  state.model = normalize(state.feed, new Date());
  applyShades();
}

/**
 * Give routes that overlap on the map different shades of their site's colour. Uses the road shapes where they're
 * known. Returns true if any route changed shade.
 */
function applyShades(): boolean {
  const model = state.model;
  if (!model) return false;
  const next = assignShades(model.corridors, (c) => lineFor(c, state.shapes), state.shades);
  let changed = false;
  for (const c of model.corridors) {
    const shade = next.get(c.id) ?? 0;
    if (c.shade !== shade) changed = true;
    c.shade = shade;
  }
  state.shades = next;
  return changed;
}

/** One line per site that didn't answer. */
/** GitHub Pages version: the trips are published by a scheduled job every ~10 minutes. Say so if it is running late. */
const LATE_MS = 45 * 60 * 1000;
function lateBanner(snapshotAt: string | undefined): string | null {
  if (!STATIC || !snapshotAt || Date.now() - Date.parse(snapshotAt) < LATE_MS) return null;
  return `These trips were last checked at ${fmtTime(new Date(snapshotAt))}. The automatic update is running late, so some may already be taken.`;
}

function sitesBanner(list: ProviderStatus[]): string | null {
  const down = list.filter((p) => p.error && !p.loading);
  if (!down.length) return null;
  const parts = down.map((p) =>
    p.stale && p.fetchedAt ? `${p.name} didn’t answer, so its trips are from ${fmtTime(new Date(p.fetchedAt))}` : `${p.name} couldn’t be reached, so its trips are missing`,
  );
  return `${parts.join('. ')}. The map tries again on the next refresh.`;
}

// ---------- "new" trips ----------

type SeenStore = Partial<Record<ProviderId, string[]>>;

function readSeen(): SeenStore {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as SeenStore;
    // Carry over what the Hertz-only version had seen, so the "New" badges stay meaningful
    const old = JSON.parse(localStorage.getItem(OLD_SEEN_KEY) || 'null');
    if (Array.isArray(old)) return { hertz: old.map((n) => `hertz:${n}`) };
  } catch {
    /* storage unavailable */
  }
  return {};
}

function writeSeen(seen: SeenStore) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    localStorage.removeItem(OLD_SEEN_KEY);
  } catch {
    /* storage unavailable: "new" badges just won't persist */
  }
}

/**
 * Marks trips that weren't there before as new: compared with your last visit on the first load,
 * then with the previous refresh. Returns the ones that appeared since the previous refresh (for alerts).
 * A site that hasn't answered is skipped, so its trips don't all look new when it comes back.
 */
function trackNewTrips(feed: RoutesResponse): string[] {
  const ids = new Map<ProviderId, string[]>();
  for (const o of feed.offers) {
    if (!ids.has(o.provider)) ids.set(o.provider, []);
    ids.get(o.provider)!.push(o.id);
  }
  const seen = readSeen();
  const fresh: string[] = [];
  for (const st of feed.providers) {
    if (st.loading || (st.error && !st.stale)) continue;
    const now = ids.get(st.id) ?? [];
    const prev = state.prevIds[st.id];
    if (!now.length && prev?.size) continue; // an empty answer right after a full one is more likely a hiccup
    if (prev) {
      for (const id of now) {
        if (prev.has(id)) continue;
        state.newRouteIds.add(id);
        fresh.push(id);
      }
    } else if (seen[st.id]) {
      const before = new Set(seen[st.id]);
      for (const id of now) if (!before.has(id)) state.newRouteIds.add(id);
    }
    state.prevIds[st.id] = new Set(now);
    seen[st.id] = now;
  }
  writeSeen(seen);
  return fresh;
}

// ---------- alerts ----------

function readAlerts(): boolean {
  try {
    return localStorage.getItem(ALERTS_KEY) === '1';
  } catch {
    return false;
  }
}

const canNotify = () => 'Notification' in window && Notification.permission === 'granted';

async function toggleAlerts() {
  if (state.alerts) {
    state.alerts = false;
    toast('Alerts are off.');
  } else {
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* older browsers: no promise, no notifications */
      }
    }
    state.alerts = true;
    toast(
      canNotify()
        ? 'Alerts are on. You’ll get a notification when a new trip matches your filters, as long as this tab stays open.'
        : 'Alerts are on, but this browser blocks notifications for the page. New trips will show up here and in the tab title while the tab is open.',
    );
  }
  try {
    localStorage.setItem(ALERTS_KEY, state.alerts ? '1' : '0');
  } catch {
    /* not remembered */
  }
  sidebar.setAlerts(state.alerts);
}

/** Tell you about trips that appeared since the last refresh and fit your current filters and trip plan. */
function alertNew(fresh: string[]) {
  const model = state.model;
  if (!state.alerts || !model) return;
  const freshIds = new Set(fresh);
  const f = state.filters;
  const matcher = makeMatcher({ from: f.fromPlace, to: f.toPlace, radiusKm: f.radiusKm, route: state.planRoute });
  const hits = applyFilters(model.corridors, f, { focusStation: null, matcher }).list.filter((c) => c.cars.some((car) => freshIds.has(car.routeId)));
  if (!hits.length) return;

  const now = new Date();
  const line = (c: Corridor) => `${PROVIDERS[c.provider].short}: ${c.from.place} → ${c.to.place}, ${c.status === 'now' ? 'available now' : `from ${fmtWhen(c.earliestFrom, now)}`}`;
  const title = hits.length === 1 ? `New trip: ${hits[0].from.place} → ${hits[0].to.place}` : `${hits.length} new trips match your filters`;
  const body = hits.length === 1 ? `${PROVIDERS[hits[0].provider].name}, ${plural(hits[0].carCount, 'car', 'cars')}, ${hits[0].status === 'now' ? 'available now' : `from ${fmtWhen(hits[0].earliestFrom, now)}`}` : [...hits.slice(0, 3).map(line), hits.length > 3 ? `and ${hits.length - 3} more` : ''].filter(Boolean).join('\n');

  if (document.hidden && canNotify()) {
    try {
      const n = new Notification(title, { body, icon: '/favicon.svg' });
      n.onclick = () => {
        window.focus();
        selectCorridor(hits[0].id);
        n.close();
      };
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }
  if (document.hidden) {
    state.unseenAlerts += hits.length;
    document.title = `(${state.unseenAlerts}) ${APP_TITLE}`;
  }
  toast(hits.length === 1 ? `${title}. ${body}.` : `${title}.`, { label: hits.length === 1 ? 'Show' : 'Show the first', run: () => selectCorridor(hits[0].id) }, 15000);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  state.unseenAlerts = 0;
  document.title = APP_TITLE;
});

let toastTimer = 0;
function toast(text: string, action?: { label: string; run: () => void }, ms = 8000) {
  const parts: HTMLElement[] = [h('p', null, text)];
  if (action) {
    parts.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            hideToast();
            action.run();
          },
        },
        action.label,
      ),
    );
  }
  parts.push(h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Dismiss', onclick: hideToast }, '×'));
  toastEl.replaceChildren(...parts);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, ms);
}
function hideToast() {
  toastEl.hidden = true;
}

// ---------- road shapes ----------

// The local server looks each road up once and keeps it on disk. We fetch only the shapes that are new
// since the last check, and keep them in memory for the whole session.
let geometryTimer = 0;
let geometrySince = 0;
const shapesWanted = new Set<string>();
async function pollGeometry() {
  clearTimeout(geometryTimer);
  try {
    const want = [...shapesWanted];
    shapesWanted.clear();
    const g = await fetchGeometry(geometrySince, want);
    geometrySince = g.serverTime;
    const keys = Object.keys(g.shapes);
    for (const k of keys) {
      const s = g.shapes[k];
      state.shapes[k] = decodePolyline(s.p);
      if (s.km != null) state.roads.set(k, { km: s.km, min: s.min });
    }
    if (keys.length) {
      // real road shapes can change which routes overlap, and so their shades
      if (applyShades()) render();
      else renderMap(true);
      if (state.selected) refreshPanel(false);
    }
    showRoadStatus(g.pending);
    if (g.pending > 0) geometryTimer = window.setTimeout(pollGeometry, 3000);
  } catch {
    geometryTimer = window.setTimeout(pollGeometry, 20000);
  }
}

function showRoadStatus(pending: number) {
  roadsEl.hidden = pending === 0;
  roadsEl.textContent = `Finding the fastest road for ${pending} ${pending === 1 ? 'route' : 'routes'}…`;
}

const roadFor = (c: Corridor) => state.roads.get(geoKey(c.from, c.to)) ?? null;

// ---------- rendering ----------

function visibleStations(corridors: Corridor[]): Station[] {
  if (!state.model) return [];
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  const hasNow = new Set<string>();
  for (const c of corridors) {
    for (const car of c.cars) {
      if (!out.has(c.from.code)) out.set(c.from.code, new Set());
      out.get(c.from.code)!.add(car.offerId);
      if (!inn.has(c.to.code)) inn.set(c.to.code, new Set());
      inn.get(c.to.code)!.add(car.offerId);
      if (car.status === 'now') hasNow.add(c.from.code);
    }
  }
  const codes = new Set([...out.keys(), ...inn.keys()]);
  if (state.focusStation) codes.add(state.focusStation);
  return [...codes]
    .map((code) => state.model!.stations.get(code))
    .filter((s): s is Station => !!s)
    .map((s) => ({ ...s, outCars: out.get(s.code)?.size ?? 0, inCars: inn.get(s.code)?.size ?? 0, hasNow: hasNow.has(s.code) }));
}

function renderMap(keepChooser = false) {
  tripMap.setData(state.visible, visibleStations(state.visible), state.shapes, keepChooser);
  updateFlow();
}

/**
 * The light that runs along the selected trip shows which way it goes. With a trip plan it runs the whole journey:
 * from you to the pick-up, along the car's road, and on to your destination.
 */
function updateFlow() {
  const c = state.selected ? state.model?.corridors.find((x) => x.id === state.selected) : undefined;
  if (!c) return tripMap.setFlow(null);
  const f = state.filters;
  const road = lineFor(c, state.shapes);
  const planned = state.matches.has(c.id);
  const start: [number, number][] = planned && f.fromPlace ? [[f.fromPlace.lon, f.fromPlace.lat]] : [];
  const end: [number, number][] = planned && f.toPlace ? [[f.toPlace.lon, f.toPlace.lat]] : [];
  tripMap.setFlow([...start, ...road, ...end]);
}

// ---------- trip planning ----------

/** Look up the road route between your start and destination (cached on the server). */
async function updatePlanRoute() {
  const { fromPlace: a, toPlace: b } = state.filters;
  if (!a || !b) {
    state.planRoute = null;
    state.planRouteKey = '';
    state.planRouteState = 'idle';
    return;
  }
  const key = `${a.lat.toFixed(5)},${a.lon.toFixed(5)}>${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;
  if (key === state.planRouteKey) return;
  state.planRouteKey = key;
  state.planRoute = null;
  state.planRouteState = 'loading';
  render();
  try {
    const r = await fetchPlanRoute(a, b);
    if (state.planRouteKey !== key) return;
    state.planRoute = buildRoute(decodePolyline(r.p), r.min, true);
    state.planRouteState = 'idle';
  } catch {
    if (state.planRouteKey === key) state.planRouteState = 'failed';
  }
  if (state.planRouteKey === key) {
    render();
    fitPlan();
  }
}

const who = (label: string) => (label === 'My location' ? 'you' : label);

function planNote(mode: ReturnType<typeof planMode>, count: number): string | null {
  const f = state.filters;
  const trips = count === 1 ? '1 trip' : `${count} trips`;
  if (mode === 'near') return `${trips} start within ${f.radiusKm} km of ${who(f.fromPlace!.label)}.`;
  if (mode === 'arrive') return `${trips} end within ${f.radiusKm} km of ${f.toPlace!.label}.`;
  if (mode === 'route') {
    const a = f.fromPlace!.label === 'My location' ? 'Your trip' : f.fromPlace!.label;
    if (state.planRouteState === 'loading') return `Finding the road from ${who(f.fromPlace!.label)} to ${f.toPlace!.label}…`;
    const length = state.planRoute
      ? `${a} → ${f.toPlace!.label} is ${Math.round(state.planRoute.totalKm)} km by road.`
      : `${a} → ${f.toPlace!.label} is about ${Math.round(haversineKm(f.fromPlace!.lat, f.fromPlace!.lon, f.toPlace!.lat, f.toPlace!.lon))} km in a straight line (the road route didn’t load).`;
    return `${length} ${count ? `${trips} can take you part of the way.` : 'No trips go your way right now.'}`;
  }
  return null;
}

/** Zoom to the area that matters for the trip plan. */
function fitPlan() {
  const f = state.filters;
  const mode = planMode(f.fromPlace, f.toPlace);
  if (!mode) return;
  const pts: [number, number][] = [];
  if (mode === 'near') {
    pts.push(...circlePolygon(f.fromPlace!.lat, f.fromPlace!.lon, f.radiusKm));
  } else if (mode === 'arrive') {
    pts.push(...circlePolygon(f.toPlace!.lat, f.toPlace!.lon, f.radiusKm));
  } else {
    pts.push(...(state.planRoute?.coords ?? []), [f.fromPlace!.lon, f.fromPlace!.lat], [f.toPlace!.lon, f.toPlace!.lat]);
    for (const c of state.visible) pts.push([c.from.lon, c.from.lat], [c.to.lon, c.to.lat]);
  }
  tripMap.fitPoints(pts, 10);
}

/** Dotted train/bus legs: you → pick-up, and drop-off → destination. */
function legsFor(c: Corridor | undefined): [number, number][][] {
  const f = state.filters;
  if (!c || !state.matches.has(c.id)) return [];
  const legs: [number, number][][] = [];
  if (f.fromPlace) legs.push([[f.fromPlace.lon, f.fromPlace.lat], [c.from.lon, c.from.lat]]);
  if (f.toPlace) legs.push([[c.to.lon, c.to.lat], [f.toPlace.lon, f.toPlace.lat]]);
  return legs;
}

function render() {
  const model = state.model;
  if (!model) return;
  const now = new Date();
  const f = state.filters;
  const mode = planMode(f.fromPlace, f.toPlace);
  const matcher = makeMatcher({ from: f.fromPlace, to: f.toPlace, radiusKm: f.radiusKm, route: state.planRoute });
  const result = applyFilters(model.corridors, f, { focusStation: state.focusStation, matcher, now });
  // While the road for a trip plan is being looked up, show nothing rather than guesses from a straight line
  const searching = mode === 'route' && state.planRouteState === 'loading';
  state.visible = searching ? [] : result.list;
  state.matches = searching ? new Map() : result.matches;
  renderMap();
  tripMap.setPlan(
    mode ? { mode, from: f.fromPlace, to: f.toPlace, radiusKm: f.radiusKm, route: state.planRoute?.coords ?? null, loading: state.planRouteState === 'loading' } : null,
  );
  tripMap.setLegs(legsFor(model.corridors.find((c) => c.id === state.selected)));
  sidebar.setPlanNote(planNote(mode, result.list.length), mode === 'route' && state.planRouteState === 'loading');
  sidebar.setStats(model, state.fetchedAt);
  const newCorridors = new Set(model.corridors.filter((c) => c.cars.some((car) => state.newRouteIds.has(car.routeId))).map((c) => c.id));
  sidebar.setList(state.visible, newCorridors, state.selected, now, state.matches, searching);
  sidebar.setFocus(state.focusStation ? (model.stations.get(state.focusStation) ?? null) : null);
  refreshPanel(false);
}

const panelHandlers = {
  onClose: () => closePanel(),
  onSelectCorridor: (id: string) => selectCorridor(id),
  onSelectStation: (code: string) => selectStation(code),
  onShowAll: () => {
    state.focusStation = null;
    closePanel();
  },
};

function refreshPanel(focus: boolean) {
  const model = state.model;
  if (!model || panelEl.hidden) return;
  const now = new Date();
  if (state.selected) {
    const c = model.corridors.find((x) => x.id === state.selected);
    const match = c ? state.matches.get(c.id) : undefined;
    const f = state.filters;
    const plan = match
      ? {
          match,
          from: f.fromPlace,
          to: f.toPlace,
          totalKm: state.planRoute?.totalKm ?? (f.fromPlace && f.toPlace ? haversineKm(f.fromPlace.lat, f.fromPlace.lon, f.toPlace.lat, f.toPlace.lon) : null),
          byRoad: !!state.planRoute,
        }
      : null;
    if (c) renderCorridorPanel(panelEl, c, now, panelHandlers, focus, plan, roadFor(c));
    else {
      panelEl.replaceChildren(
        h(
          'div',
          { class: 'panel-head' },
          h('button', { type: 'button', class: 'icon-btn panel-close', 'aria-label': 'Close details', onclick: () => closePanel() }, '×'),
          h('h2', { class: 'panel-title' }, 'This trip is gone'),
          h('p', { class: 'panel-sub' }, 'Someone booked it or the offer ended since the last refresh.'),
        ),
      );
    }
  } else if (state.focusStation) {
    const s = model.stations.get(state.focusStation);
    if (!s) return closePanel();
    const outgoing = state.visible.filter((c) => c.from.code === s.code);
    const incoming = state.visible.filter((c) => c.to.code === s.code);
    renderStationPanel(panelEl, s, outgoing, incoming, now, panelHandlers, focus);
  }
}

function openPanel() {
  panelEl.hidden = false;
  document.body.classList.add('panel-open');
  updatePadding();
}

function closePanel() {
  tripMap.closeChooser();
  panelEl.hidden = true;
  document.body.classList.remove('panel-open');
  const hadFocus = !!state.focusStation;
  state.selected = null;
  state.focusStation = null;
  tripMap.select(null);
  tripMap.setLegs([]);
  tripMap.setFlow(null);
  sidebar.markSelected(null);
  updatePadding();
  if (hadFocus) render();
}

function selectCorridor(id: string) {
  const c = state.model?.corridors.find((x) => x.id === id);
  if (!c) return;
  state.autoFit = false;
  state.selected = id;
  if (isMobile()) sidebarEl.classList.remove('open');
  openPanel();
  tripMap.select(id);
  sidebar.markSelected(id);
  refreshPanel(true);
  updatePadding();
  const legs = legsFor(c);
  tripMap.setLegs(legs);
  updateFlow();
  if (legs.length) tripMap.fitPoints([...lineFor(c, state.shapes), ...legs.flat()], 10);
  else tripMap.fitCorridor(c, state.shapes);
  // Ask the server to look this road up next if it isn't saved yet
  const key = geoKey(c.from, c.to);
  if (!state.shapes[key]) {
    shapesWanted.add(key);
    void pollGeometry();
  }
}

function selectStation(code: string) {
  const s = state.model?.stations.get(code);
  if (!s) return;
  state.autoFit = false;
  state.selected = null;
  state.focusStation = code;
  tripMap.select(null);
  if (isMobile()) sidebarEl.classList.remove('open');
  openPanel();
  render();
  refreshPanel(true);
  updatePadding();
  const related = visibleStations(state.visible);
  tripMap.fitStations(related.length > 1 ? related : [s], 9);
}

function updatePadding() {
  const panelOpen = !panelEl.hidden;
  if (isMobile()) {
    const sheet = panelOpen ? Math.min(panelEl.offsetHeight || window.innerHeight * 0.58, window.innerHeight * 0.58) : 128;
    tripMap.setPadding({ top: 64, left: 24, right: 24, bottom: Math.round(sheet) + 16 });
  } else {
    tripMap.setPadding({ top: 60, left: 60, bottom: 60, right: panelOpen ? panelEl.offsetWidth + 40 || 460 : 60 });
  }
}

// ---------- banner (one line per problem; dismissing hides those lines until the text changes) ----------

const banners = new Map<string, string>();
const dismissed = new Set<string>();

function setBanner(key: string, text: string | null) {
  if (text) banners.set(key, text);
  else banners.delete(key);
  renderBanner();
}

function renderBanner() {
  const texts = [...banners.values()].filter((t) => !dismissed.has(t));
  bannerEl.hidden = !texts.length;
  if (!texts.length) return;
  bannerEl.replaceChildren(
    h('div', { class: 'banner-text' }, texts.map((t) => h('p', null, t))),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': 'Dismiss',
        onclick: () => {
          texts.forEach((t) => dismissed.add(t));
          renderBanner();
        },
      },
      '×',
    ),
  );
}

// ---------- map key ----------

/** White dot inside a ring split between the sites' colours. */
function ringOfColours() {
  const step = 360 / PROVIDER_ORDER.length;
  const ring = PROVIDER_ORDER.map((id, i) => `${PROVIDERS[id].colors.now} ${i * step}deg ${(i + 1) * step}deg`).join(', ');
  return `radial-gradient(circle, #ece8df 0 4px, #0f1318 4.5px 5px, transparent 5.5px), conic-gradient(${ring})`;
}

function renderLegend(el: HTMLElement) {
  const line = (cls: string, label: string) => h('li', null, h('span', { class: `lg-line ${cls}`, 'aria-hidden': 'true' }), label);
  el.replaceChildren(
    h(
      'details',
      { open: !isMobile() },
      h('summary', null, 'Map key'),
      h('p', { class: 'lg-head' }, 'Colour shows the site'),
      h(
        'ul',
        { class: 'lg-sites' },
        PROVIDER_ORDER.map((id) =>
          h(
            'li',
            { 'data-provider': id },
            // the site's shades side by side: overlapping routes are drawn in different ones
            h('span', { class: 'lg-line lg-site', 'aria-hidden': 'true', style: { background: `linear-gradient(90deg, ${PROVIDERS[id].shades.join(', ')})` } }),
            PROVIDERS[id].name,
          ),
        ),
      ),
      h('p', { class: 'lg-note' }, 'Overlapping routes get different shades'),
      h('p', { class: 'lg-head' }, 'Line shows when'),
      h(
        'ul',
        null,
        line('lg-now', 'Available now'),
        line('lg-expiring', 'Pulsing: ends within 12 hours'),
        line('lg-soon', 'Opens within a day'),
        line('lg-later', 'Opens later'),
        h('li', null, h('span', { class: 'lg-line lg-arrow', 'aria-hidden': 'true' }), 'Arrow points the way you drive'),
        h('li', null, h('span', { class: 'lg-widths', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'Thicker means more cars'),
        h('li', null, h('span', { class: 'lg-dot', 'aria-hidden': 'true', style: { background: ringOfColours() } }), 'Pick-up point, ringed in the site’s colour'),
      ),
    ),
  );
}

// ---------- refresh loop ----------

void load();
setInterval(() => {
  if (document.visibilityState === 'visible' || state.alerts) void load();
}, REFRESH_MS);
setInterval(() => {
  recompute();
  render();
}, TICK_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.lastLoad > 2 * 60 * 1000) void load();
});

// Handy when poking at the map from the browser console.
Object.assign(window, { __tripMap: tripMap });
