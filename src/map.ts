import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type StyleSpecification, type SymbolLayerSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { h, plural, prefersReducedMotion } from './dom';
import { fmtWhen } from './format';
import { bufferLine } from './buffer';
import { boundsOf, lineFor, type Shapes } from './geometry';
import type { Feature } from 'geojson';
import { stationLabel } from './normalize';
import { circlePolygon, type Place, type PlanMode } from './plan';
import { PROVIDERS, PROVIDER_ORDER } from './providers';
import { setLineVars, shadeColors } from './shades';
import type { Corridor, Station } from './types';

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#11151b' } }],
};

export const COLORS = {
  tail: '#ff5d4f',
  arrow: '#0b0906', // direction arrows: near-black, outlined in the line's colour
  ink: '#ece8df',
  night: '#0f1318',
  notch: '#14100c',
};

/** The site's main colour (used for station rings and glows). */
const pColor = (shade: 'now' | 'soon' | 'later'): ExpressionSpecification =>
  ['match', ['get', 'provider'], ...PROVIDER_ORDER.flatMap((p) => [p, PROVIDERS[p].colors[shade]]), PROVIDERS.hertz.colors[shade]] as unknown as ExpressionSpecification;

/** Line colour for a route: its own shade of the site's colour (see shades.ts), lighter when dashed, deeper when dotted. */
const lineColor = (shade: 'now' | 'soon' | 'later'): ExpressionSpecification =>
  ['coalesce', ['get', shade === 'now' ? 'cNow' : shade === 'soon' ? 'cSoon' : 'cLater'], pColor(shade)] as unknown as ExpressionSpecification;
const lineColorByRank: ExpressionSpecification = ['match', ['get', 'rank'], 0, lineColor('now'), 1, lineColor('soon'), lineColor('later')];

export interface MapHandlers {
  onSelectCorridor(id: string): void;
  onSelectStation(code: string): void;
  onClearSelection(): void;
  onHoverCorridor(id: string | null): void;
  onBasemapFailed(): void;
}

type Padding = { top: number; bottom: number; left: number; right: number };

export interface MapPlan {
  mode: PlanMode;
  from: Place | null;
  to: Place | null;
  radiusKm: number;
  route: [number, number][] | null; // [lon, lat], route mode only
  /** the road route is still being looked up (route mode) */
  loading?: boolean;
}

// Width grows with the number of cars on the route, and with zoom.
const carsWidth: ExpressionSpecification = ['interpolate', ['linear'], ['get', 'cars'], 1, 2.2, 2, 3.1, 4, 4.4, 8, 6.4];
const lineWidth = (mult = 1, add = 0): ExpressionSpecification => [
  'interpolate',
  ['linear'],
  ['zoom'],
  4,
  ['+', ['*', carsWidth, 0.72 * mult], add],
  9,
  ['+', ['*', carsWidth, 1.1 * mult], add],
  13,
  ['+', ['*', carsWidth, 1.6 * mult], add],
];
const stationRadius = (add = 0): ExpressionSpecification => [
  'interpolate',
  ['linear'],
  ['zoom'],
  4,
  ['interpolate', ['linear'], ['get', 'out'], 0, 2 + add, 1, 3 + add, 12, 6.5 + add],
  10,
  ['interpolate', ['linear'], ['get', 'out'], 0, 3.5 + add, 1, 5 + add, 12, 10 + add],
];
const BASE_LAYERS: Record<string, number> = { 'cor-later': 0.5, 'cor-soon': 0.8, 'cor-now-glow': 0.2, 'cor-now': 0.95 };
const ARROW_OPACITY: ExpressionSpecification = ['match', ['get', 'rank'], 0, 0.85, 1, 0.75, 0.55];

// ---------- line-gradient helpers (light running along a line; needs a source with lineMetrics) ----------

const INK_RGB = '236, 232, 223';
type Alpha = (t: number) => number;

/** A gradient along the line from 0 (start) to 1 (end), sampled finely, plus exact stops at the given positions. */
function gradient(alphaAt: Alpha, exact: number[] = []): ExpressionSpecification {
  const at = new Set<number>();
  for (let i = 0; i <= 48; i++) at.add(i / 48);
  for (const t of exact) for (const d of [-0.004, 0, 0.004]) if (t + d > 0 && t + d < 1) at.add(Math.round((t + d) * 1e5) / 1e5);
  const expr: unknown[] = ['interpolate', ['linear'], ['line-progress']];
  let prev = -1;
  for (const t of [...at].sort((a, b) => a - b)) {
    if (t - prev < 1e-4) continue;
    prev = t;
    expr.push(t, `rgba(${INK_RGB}, ${Math.max(0, Math.min(1, alphaAt(t))).toFixed(3)})`);
  }
  return expr as unknown as ExpressionSpecification;
}
const solid = (alpha: number): ExpressionSpecification => ['interpolate', ['linear'], ['line-progress'], 0, `rgba(${INK_RGB}, ${alpha})`, 1, `rgba(${INK_RGB}, ${alpha})`];
/** Bright head at `p` with a tail fading out behind it (towards the start). */
const comet =
  (p: number, tail: number, peak: number): Alpha =>
  (t) =>
    t > p + 0.006 ? 0 : t > p ? peak * (1 - (t - p) / 0.006) : peak * Math.exp((-3 * (p - t)) / tail);
/** Like `comet`, but with a fuller tail that stays bright for longer before fading. */
const glow =
  (p: number, tail: number, peak: number): Alpha =>
  (t) => {
    if (t > p + 0.006) return 0;
    if (t > p) return peak * (1 - (t - p) / 0.006);
    const d = (p - t) / tail;
    return d >= 1 ? 0 : peak * (1 - d) ** 2;
  };
/** Drawn from the start up to `p`, with a short soft edge. */
const drawn =
  (p: number, alpha: number): Alpha =>
  (t) =>
    t <= p ? alpha : t < p + 0.012 ? alpha * (1 - (t - p) / 0.012) : 0;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const lineFeature = (coordinates: [number, number][]): Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } });
const polygonFeature = (ring: [number, number][]): Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
const ROUTE_ALPHA = 0.6; // your planned road, once drawn

export class TripMap {
  readonly map: maplibregl.Map;
  private readyPromise: Promise<void>;
  private corridors = new Map<string, Corridor>();
  private stations = new Map<string, Station>();
  private indexOf = new Map<string, number>();
  private hoverIdx: number | null = null;
  private selectedIdx: number | null = null;
  private selectedId: string | null = null;
  private chooser: maplibregl.Popup | null = null;
  private padding: Padding = { top: 48, bottom: 48, left: 48, right: 48 };
  private loaded = false;
  private fellBack = false;
  private hasGlyphs = true;
  private raf = 0;
  private plan: MapPlan | null = null;
  private legs: [number, number][][] = [];
  private hasExpiring = false;
  // one animation loop for everything that moves (the "ends soon" pulse, the trip-plan reveal, the direction glow)
  private anims = new Map<string, (ts: number) => boolean>();
  private loopRaf = 0;
  private planSig = '';
  private planKey = '';
  private planRadius = 0;
  private circleKm = 0;
  private flowSig = '';
  private flowCoords: [number, number][] | null = null;

  constructor(
    container: HTMLElement,
    private tooltip: HTMLElement,
    private handlers: MapHandlers,
  ) {
    this.map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: [15, 62],
      zoom: 4.2,
      minZoom: 2,
      maxZoom: 16,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    this.readyPromise = new Promise((resolve) => {
      this.map.on('load', () => {
        this.loaded = true;
        this.setup();
        resolve();
      });
    });
    // If the dark basemap can't be fetched, fall back to a plain dark background so the trips still show. Only the
    // basemap's style itself counts (a missing tile or font is no reason to drop the whole basemap), and only time
    // with the page on screen counts: a tab opened in the background draws nothing until it's shown, and used to
    // lose a perfectly good basemap after 12 seconds.
    let styleArrived = false;
    this.map.once('styledata', () => {
      styleArrived = true;
    });
    const fallback = () => {
      if (this.loaded || this.fellBack) return;
      this.fellBack = true;
      this.handlers.onBasemapFailed();
      this.map.setStyle(FALLBACK_STYLE);
    };
    this.map.on('error', (e) => {
      const err = (e as { error?: { message?: string; url?: string } }).error;
      const text = `${err?.url ?? ''} ${err?.message ?? ''}`;
      if (!this.loaded && !styleArrived && (text.includes('style.json') || text.includes(STYLE_URL))) fallback();
    });
    let waited = 0;
    const timer = window.setInterval(() => {
      if (this.loaded || this.fellBack) return window.clearInterval(timer);
      if (document.hidden) return;
      waited += 1000;
      if (waited >= 12000 && !styleArrived) {
        window.clearInterval(timer);
        fallback();
      }
    }, 1000);
  }

  whenReady() {
    return this.readyPromise;
  }

  setPadding(p: Padding) {
    this.padding = p;
  }

  private setup() {
    const map = this.map;
    const style = map.getStyle();
    this.hasGlyphs = !!style.glyphs;
    const firstSymbol = style.layers.find((l) => l.type === 'symbol')?.id;

    // Quieter basemap place names so the station labels lead.
    for (const l of style.layers) {
      if (l.type === 'symbol' && /^place_/.test(l.id) && !/country|continent|state/.test(l.id)) {
        map.setPaintProperty(l.id, 'text-opacity', 0.45);
      }
    }

    map.addImage('chevron', chevronImage(), { sdf: true, pixelRatio: 2 });
    map.addImage('arrowhead', arrowheadSdf(), { sdf: true, pixelRatio: 2 });
    map.addSource('corridors', { type: 'geojson', data: emptyFc() });
    map.addSource('stations', { type: 'geojson', data: emptyFc() });

    const round = { 'line-cap': 'round', 'line-join': 'round' } as const;
    map.addLayer(
      {
        id: 'cor-later',
        type: 'line',
        source: 'corridors',
        filter: ['==', ['get', 'rank'], 2],
        layout: round,
        paint: { 'line-color': lineColor('later'), 'line-width': lineWidth(0.8), 'line-opacity': BASE_LAYERS['cor-later'], 'line-dasharray': [0.6, 1.8] },
      },
      firstSymbol,
    );
    map.addLayer(
      {
        id: 'cor-soon',
        type: 'line',
        source: 'corridors',
        filter: ['==', ['get', 'rank'], 1],
        layout: round,
        paint: { 'line-color': lineColor('soon'), 'line-width': lineWidth(0.85), 'line-opacity': BASE_LAYERS['cor-soon'], 'line-dasharray': [2.4, 1.5] },
      },
      firstSymbol,
    );
    map.addLayer(
      {
        id: 'cor-now-glow',
        type: 'line',
        source: 'corridors',
        filter: ['==', ['get', 'rank'], 0],
        layout: round,
        paint: { 'line-color': lineColor('now'), 'line-width': lineWidth(3.4), 'line-blur': 7, 'line-opacity': BASE_LAYERS['cor-now-glow'] },
      },
      firstSymbol,
    );
    // Trips that end within 12 hours "breathe": a wide glow that fades in and out (still if reduced motion is on)
    map.addLayer(
      {
        id: 'cor-pulse',
        type: 'line',
        source: 'corridors',
        filter: ['all', ['==', ['get', 'rank'], 0], ['get', 'expiring']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': lineColor('now'), 'line-width': lineWidth(5), 'line-blur': 9, 'line-opacity': 0.35 },
      },
      firstSymbol,
    );
    map.addLayer(
      {
        id: 'cor-now',
        type: 'line',
        source: 'corridors',
        filter: ['==', ['get', 'rank'], 0],
        layout: round,
        paint: { 'line-color': lineColor('now'), 'line-width': lineWidth(1), 'line-opacity': BASE_LAYERS['cor-now'] },
      },
      firstSymbol,
    );
    // Faint, soft outline around the hovered / selected route (the rest of the map dims, so it needn't shout)
    map.addLayer(
      {
        id: 'cor-focus',
        type: 'line',
        source: 'corridors',
        layout: round,
        paint: {
          'line-color': COLORS.ink,
          'line-gap-width': lineWidth(1),
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 1.6, 1.2],
          'line-blur': 0.8,
          'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.5, ['boolean', ['feature-state', 'hover'], false], 0.35, 0],
        },
      },
      firstSymbol,
    );
    // Which way each trip goes: small dark arrowheads sitting in the line, with a hairline of the line's colour round them
    map.addLayer(
      {
        id: 'cor-arrows',
        type: 'symbol',
        source: 'corridors',
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 3, 130, 7, 180, 12, 260],
          'icon-image': 'arrowhead',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.42, 7, 0.55, 12, 0.7],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-rotation-alignment': 'map',
          'icon-keep-upright': false,
        },
        paint: {
          'icon-color': COLORS.arrow,
          'icon-halo-color': lineColorByRank,
          'icon-halo-width': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 12, 2.2],
          'icon-opacity': ARROW_OPACITY,
        },
      },
      firstSymbol,
    );
    // Invisible wide line that makes thin routes easy to hover and click
    map.addLayer({
      id: 'cor-hit',
      type: 'line',
      source: 'corridors',
      layout: round,
      paint: { 'line-color': '#000', 'line-width': 16, 'line-opacity': 0.01 },
    });

    map.addLayer({
      id: 'st-glow',
      type: 'circle',
      source: 'stations',
      filter: ['get', 'hasNow'],
      paint: { 'circle-radius': stationRadius(6), 'circle-color': pColor('now'), 'circle-opacity': 0.18, 'circle-blur': 0.7 },
    });
    map.addLayer({
      id: 'st-dot',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-radius': stationRadius(),
        'circle-color': ['case', ['>', ['get', 'out'], 0], COLORS.ink, COLORS.night],
        // ring in the provider's colour, so you can tell whose pickup point it is
        'circle-stroke-color': pColor('now'),
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 1.4, 10, 2.2],
        'circle-stroke-opacity': 0.95,
      },
    });
    if (this.hasGlyphs) {
      const label = (id: string, minzoom: number, filter: ExpressionSpecification, size: [number, number], color: ExpressionSpecification | string): SymbolLayerSpecification => ({
        id,
          type: 'symbol',
          source: 'stations',
          minzoom,
          filter,
          layout: {
            'text-field': ['step', ['zoom'], ['get', 'place'], 8.5, ['get', 'short']],
            'text-font': ['Montserrat Medium'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 4, size[0], 10, size[1]],
            'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
            'text-radial-offset': 0.95,
            'text-justify': 'auto',
            'text-max-width': 12,
            'symbol-sort-key': ['*', -1, ['get', 'out']],
          },
          paint: { 'text-color': color, 'text-halo-color': 'rgba(12, 14, 18, 0.92)', 'text-halo-width': 1.5 },
        });
      map.addLayer(label('st-label-hub', 0, ['>=', ['get', 'out'], 3], [11.5, 13.5], COLORS.ink));
      map.addLayer(label('st-label', 5.6, ['<', ['get', 'out'], 3], [10.5, 12.5], ['case', ['>', ['get', 'out'], 0], COLORS.ink, '#9aa1ab']));
    }

    this.addPlanLayers();

    map.on('mousemove', (e) => {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.onMove(e.point, e.originalEvent));
    });
    map.getCanvas().addEventListener('mouseleave', () => this.clearHover());
    document.addEventListener('visibilitychange', () => {
      // animations pause while the tab is hidden and carry on when it's shown again
      if (!document.hidden && this.anims.size && !this.loopRaf) this.loopRaf = requestAnimationFrame(this.frame);
    });
    map.on('click', (e) => this.onClick(e.point, e.lngLat));
  }

  // ---------- trip planning overlays ----------

  private addPlanLayers() {
    const map = this.map;
    const round = { 'line-cap': 'round', 'line-join': 'round' } as const;
    const fade = { duration: 700, delay: 0 };
    map.addSource('plan-area', { type: 'geojson', data: emptyFc() });
    map.addSource('plan-route', { type: 'geojson', data: emptyFc(), lineMetrics: true });
    map.addSource('plan-legs', { type: 'geojson', data: emptyFc() });
    map.addSource('plan-points', { type: 'geojson', data: emptyFc() });
    map.addSource('flow', { type: 'geojson', data: emptyFc(), lineMetrics: true });

    // Under the trips: how far you'll travel to a car (a circle, or everything within that distance of your road).
    // A faint fill with a soft edge, in neutral white so it never looks like one site's trips.
    map.addLayer({ id: 'plan-area-fill', type: 'fill', source: 'plan-area', paint: { 'fill-color': COLORS.ink, 'fill-opacity': 0, 'fill-opacity-transition': fade } }, 'cor-later');
    map.addLayer(
      {
        id: 'plan-area-feather',
        type: 'line',
        source: 'plan-area',
        layout: round,
        paint: {
          'line-color': COLORS.ink,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 24],
          'line-blur': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 24],
          'line-opacity': 0,
          'line-opacity-transition': fade,
        },
      },
      'cor-later',
    );
    map.addLayer(
      { id: 'plan-area-edge', type: 'line', source: 'plan-area', layout: round, paint: { 'line-color': COLORS.ink, 'line-width': 1, 'line-opacity': 0, 'line-opacity-transition': fade } },
      'cor-later',
    );
    // Your road from start to destination: a thin line with small chevrons pointing the way
    map.addLayer({ id: 'plan-route-line', type: 'line', source: 'plan-route', layout: round, paint: { 'line-width': 2, 'line-gradient': solid(0) } }, 'cor-later');
    map.addLayer(
      {
        id: 'plan-route-arrows',
        type: 'symbol',
        source: 'plan-route',
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 150,
          'icon-image': 'chevron',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 9, 0.7, 13, 0.85],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-rotation-alignment': 'map',
          'icon-keep-upright': false,
        },
        paint: { 'icon-color': COLORS.ink, 'icon-opacity': 0, 'icon-opacity-transition': fade },
      },
      'cor-later',
    );
    // Over the trips, only while it plays: the glow that runs along your road as it draws in
    map.addLayer({ id: 'plan-route-glow', type: 'line', source: 'plan-route', layout: round, paint: { 'line-width': 12, 'line-blur': 9, 'line-gradient': solid(0) } }, 'cor-focus');
    // On top: dotted train/bus legs for the selected trip, the light running along it, and your start / destination
    map.addLayer({ id: 'plan-legs', type: 'line', source: 'plan-legs', layout: round, paint: { 'line-color': COLORS.ink, 'line-width': 2.6, 'line-opacity': 0.95, 'line-dasharray': [0.1, 1.9] } });
    // The light that runs along the selected trip: a soft halo with a crisp bright core
    map.addLayer({
      id: 'flow-halo',
      type: 'line',
      source: 'flow',
      layout: round,
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 9, 9, 15, 13, 22],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 4, 6, 9, 9, 13, 13],
        'line-gradient': solid(0),
      },
    });
    map.addLayer({
      id: 'flow-core',
      type: 'line',
      source: 'flow',
      layout: round,
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 9, 2.8, 13, 4], 'line-blur': 0.6, 'line-gradient': solid(0) },
    });
    map.addLayer({
      id: 'plan-points-ring',
      type: 'circle',
      source: 'plan-points',
      paint: {
        'circle-radius': 9,
        'circle-color': ['match', ['get', 'kind'], 'from', COLORS.ink, COLORS.night],
        'circle-stroke-color': COLORS.ink,
        'circle-stroke-width': 2.5,
      },
    });
    map.addLayer({
      id: 'plan-points-core',
      type: 'circle',
      source: 'plan-points',
      paint: { 'circle-radius': 3, 'circle-color': ['match', ['get', 'kind'], 'from', COLORS.night, COLORS.ink] },
    });
    if (this.hasGlyphs) {
      map.addLayer({
        id: 'plan-points-label',
        type: 'symbol',
        source: 'plan-points',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Montserrat Medium'],
          'text-size': 12.5,
          'text-offset': [0, 1.35],
          'text-anchor': 'top',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': COLORS.ink, 'text-halo-color': 'rgba(12, 14, 18, 0.95)', 'text-halo-width': 1.8 },
      });
    }
    this.setLegs(this.legs);
    this.applyPlan();
    this.applyFlow();
  }

  setPlan(plan: MapPlan | null) {
    this.plan = plan;
    if (this.loaded) this.applyPlan();
  }

  /** Dotted "get there by train or bus" legs for the selected trip. */
  setLegs(legs: [number, number][][]) {
    this.legs = legs;
    if (!this.loaded) return;
    this.setSourceData('plan-legs', legs.map(lineFeature));
  }

  private setSourceData(id: string, features: Feature[]) {
    (this.map.getSource(id) as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  /** Fade the travel area in or out (MapLibre runs the transition). */
  private showArea(on: boolean) {
    this.map.setPaintProperty('plan-area-fill', 'fill-opacity', on ? 0.05 : 0);
    this.map.setPaintProperty('plan-area-feather', 'line-opacity', on ? 0.09 : 0);
    this.map.setPaintProperty('plan-area-edge', 'line-opacity', on ? 0.2 : 0);
  }

  /** hidden: nothing drawn; drawing: the reveal paints the line itself; done: the finished line with its chevrons. */
  private routeLook(look: 'hidden' | 'drawing' | 'done') {
    this.map.setPaintProperty('plan-route-line', 'line-gradient', solid(look === 'done' ? ROUTE_ALPHA : 0));
    this.map.setPaintProperty('plan-route-glow', 'line-gradient', solid(0));
    this.map.setPaintProperty('plan-route-arrows', 'icon-opacity', look === 'done' ? 0.55 : 0);
  }

  private applyPlan() {
    const p = this.plan;
    const points: Feature[] = [];
    if (p?.from) points.push({ type: 'Feature', properties: { kind: 'from', label: p.from.label === 'My location' ? 'You' : p.from.label }, geometry: { type: 'Point', coordinates: [p.from.lon, p.from.lat] } });
    if (p?.to) points.push({ type: 'Feature', properties: { kind: 'to', label: p.to.label }, geometry: { type: 'Point', coordinates: [p.to.lon, p.to.lat] } });
    const centre = p ? (p.mode === 'near' ? p.from : p.mode === 'arrive' ? p.to : null) : null;
    const a: [number, number] | null = p?.from ? [p.from.lon, p.from.lat] : null;
    const b: [number, number] | null = p?.to ? [p.to.lon, p.to.lat] : null;
    const road = p?.mode === 'route' ? (p.route ? 'road' : p.loading ? 'search' : 'straight') : '';
    const key = !p ? '' : centre ? `${p.mode}|${centre.lat},${centre.lon}` : `route|${a}|${b}|${road}|${p.route?.length ?? 2}`;
    const radius = p?.radiusKm ?? 0;
    const sig = `${key}|${radius}|${p?.from?.label ?? ''}|${p?.to?.label ?? ''}`;
    if (sig === this.planSig) return; // render() calls this on every refresh; only act on real changes
    this.planSig = sig;
    this.setSourceData('plan-points', points);
    const fresh = key !== this.planKey;
    const radiusChanged = radius !== this.planRadius;
    this.planKey = key;
    this.planRadius = radius;
    const still = prefersReducedMotion();

    if (!p) {
      this.stop('plan-area');
      this.stop('plan-route');
      this.showArea(false);
      this.routeLook('hidden');
      this.setSourceData('plan-route', []);
      return;
    }

    if (centre) {
      // The circle grows out from the point when it's new, and eases to its new size when you move the slider
      this.stop('plan-route');
      this.routeLook('hidden');
      this.setSourceData('plan-route', []);
      const from = fresh ? 0 : this.circleKm;
      const to = radius;
      const draw = (km: number) => {
        this.circleKm = km;
        this.setSourceData('plan-area', km > 0 ? [polygonFeature(circlePolygon(centre.lat, centre.lon, km))] : []);
      };
      if (fresh) this.showArea(true);
      if (still || Math.abs(to - from) < 0.01) {
        this.stop('plan-area');
        draw(to);
        return;
      }
      const t0 = performance.now();
      const dur = fresh ? 700 : 260;
      this.play('plan-area', (ts) => {
        const x = Math.min(1, Math.max(0, (ts - t0) / dur));
        draw(from + (to - from) * easeOut(x));
        return x < 1;
      });
      return;
    }

    this.stop('plan-area');
    const coords = p.route ?? [a!, b!];
    if (fresh) this.setSourceData('plan-route', [lineFeature(coords)]);
    if (road === 'search') {
      // While the road is being looked up, a soft light keeps running from your start towards your destination
      if (!fresh) return;
      this.showArea(false);
      this.setSourceData('plan-area', []);
      this.routeLook('hidden');
      if (still) return;
      const t0 = performance.now();
      this.play('plan-route', (ts) => {
        const head = -0.05 + easeInOut(((ts - t0) % 1400) / 1400) * 1.1;
        this.map.setPaintProperty('plan-route-glow', 'line-gradient', gradient(comet(head, 0.4, 0.5), [head]));
        return true;
      });
      return;
    }
    if (fresh || radiusChanged) {
      const area = bufferLine(coords, radius);
      this.setSourceData('plan-area', area.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: area } }] : []);
    }
    if (!fresh) return;
    if (still) {
      this.stop('plan-route');
      this.routeLook('done');
      this.showArea(true);
      return;
    }
    // The road draws itself from start to destination with a glow at its head; then the area and chevrons fade in
    this.showArea(false);
    this.routeLook('drawing');
    const t0 = performance.now();
    const drawMs = 1800;
    const fadeMs = 500;
    let finished = false;
    this.play('plan-route', (ts) => {
      const t = ts - t0;
      const x = Math.min(1, Math.max(0, t / drawMs));
      if (x < 1) {
        const head = easeInOut(x);
        this.map.setPaintProperty('plan-route-line', 'line-gradient', gradient(drawn(head, ROUTE_ALPHA), [head]));
        this.map.setPaintProperty('plan-route-glow', 'line-gradient', gradient(comet(head, 0.28, 0.9), [head]));
        return true;
      }
      if (!finished) {
        finished = true;
        this.map.setPaintProperty('plan-route-line', 'line-gradient', solid(ROUTE_ALPHA));
        this.map.setPaintProperty('plan-route-arrows', 'icon-opacity', 0.55);
        this.showArea(true);
      }
      const y = Math.min(1, (t - drawMs) / fadeMs);
      this.map.setPaintProperty('plan-route-glow', 'line-gradient', gradient(comet(1, 0.28, 0.9 * (1 - y))));
      return y < 1;
    });
  }

  /** Zoom to show a set of points (e.g. your trip plan). */
  fitPoints(points: [number, number][], maxZoom = 9) {
    if (points.length) this.fit(boundsOf(points), maxZoom);
  }

  private queryAt(point: maplibregl.Point) {
    const stationBox: [maplibregl.PointLike, maplibregl.PointLike] = [
      [point.x - 5, point.y - 5],
      [point.x + 5, point.y + 5],
    ];
    const st = this.map.queryRenderedFeatures(stationBox, { layers: ['st-dot'] });
    const lineBox: [maplibregl.PointLike, maplibregl.PointLike] = [
      [point.x - 4, point.y - 4],
      [point.x + 4, point.y + 4],
    ];
    const ids = [...new Set(this.map.queryRenderedFeatures(lineBox, { layers: ['cor-hit'] }).map((f) => String(f.properties.id)))];
    const corridors = ids.map((id) => this.corridors.get(id)).filter((c): c is Corridor => !!c);
    corridors.sort((a, b) => a.rank - b.rank || b.carCount - a.carCount);
    return { station: st[0] ? this.stations.get(String(st[0].properties.code)) : undefined, corridors };
  }

  private onMove(point: maplibregl.Point, ev: MouseEvent) {
    const { station, corridors } = this.queryAt(point);
    const canvas = this.map.getCanvas();
    if (station) {
      canvas.style.cursor = 'pointer';
      this.setHoverIdx(null);
      this.handlers.onHoverCorridor(null);
      this.showTooltip(ev, [
        h('span', { class: 'ptag', 'data-provider': station.provider }, PROVIDERS[station.provider].name),
        h('strong', null, stationLabel(station)),
        h('span', null, station.outCars ? `${plural(station.outCars, 'car leaves', 'cars leave')} from here` : 'No cars leave from here right now'),
        station.inCars ? h('span', { class: 'muted' }, `${plural(station.inCars, 'car arrives', 'cars arrive')} here`) : null,
      ]);
      return;
    }
    if (!corridors.length) {
      this.clearHover();
      return;
    }
    canvas.style.cursor = 'pointer';
    const top = corridors[0];
    this.setHoverIdx(this.indexOf.get(top.id) ?? null);
    this.handlers.onHoverCorridor(top.id);
    this.showTooltip(ev, [
      h('span', { class: 'ptag', 'data-provider': top.provider }, PROVIDERS[top.provider].name),
      h('strong', null, `${top.from.place} → ${top.to.place}`),
      h('span', null, `${plural(top.carCount, 'car', 'cars')}, ${top.status === 'now' ? (top.expiresSoon ? 'available now, ending soon' : 'available now') : `from ${fmtWhen(top.earliestFrom)}`}`),
      corridors.length > 1 ? h('span', { class: 'muted' }, `${plural(corridors.length - 1, 'more route', 'more routes')} here. Click to choose.`) : null,
    ]);
  }

  private clearHover() {
    this.map.getCanvas().style.cursor = '';
    this.setHoverIdx(null);
    this.handlers.onHoverCorridor(null);
    this.tooltip.hidden = true;
  }

  private showTooltip(ev: MouseEvent, content: (Node | null)[]) {
    const rect = this.map.getContainer().getBoundingClientRect();
    this.tooltip.replaceChildren(...content.filter((n): n is Node => !!n));
    this.tooltip.hidden = false;
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const flip = x > rect.width - 260;
    this.tooltip.style.transform = `translate(${flip ? x - 14 : x + 14}px, ${y + 14}px) translateX(${flip ? '-100%' : '0'})`;
  }

  closeChooser() {
    this.chooser?.remove();
    this.chooser = null;
  }

  private onClick(point: maplibregl.Point, lngLat: maplibregl.LngLat) {
    this.closeChooser();
    this.tooltip.hidden = true;
    const { station, corridors } = this.queryAt(point);
    if (station) return this.handlers.onSelectStation(station.code);
    if (!corridors.length) return this.handlers.onClearSelection();
    if (corridors.length === 1) return this.handlers.onSelectCorridor(corridors[0].id);

    const list = h(
      'div',
      { class: 'chooser' },
      h('p', { class: 'chooser-title' }, `${corridors.length} routes overlap here`),
      corridors.slice(0, 8).map((c) =>
        setLineVars(
          h(
            'button',
            {
              type: 'button',
              class: `chooser-item status-${c.status}${c.expiresSoon ? ' expiring' : ''}`,
              'data-provider': c.provider,
              title: PROVIDERS[c.provider].name,
              onclick: () => {
                this.chooser?.remove();
                this.handlers.onSelectCorridor(c.id);
              },
            },
            h('span', { class: 'swatch', 'aria-hidden': 'true' }),
            h('span', { class: 'chooser-name' }, `${c.from.place} → ${c.to.place}`),
            h('span', { class: 'chooser-count' }, String(c.carCount)),
          ),
          c.provider,
          c.shade,
        ),
      ),
    );
    this.chooser = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', className: 'chooser-popup' }).setLngLat(lngLat).setDOMContent(list).addTo(this.map);
  }

  private setHoverIdx(idx: number | null) {
    if (idx === this.hoverIdx) return;
    if (this.hoverIdx != null) this.map.setFeatureState({ source: 'corridors', id: this.hoverIdx }, { hover: false });
    this.hoverIdx = idx;
    if (idx != null) this.map.setFeatureState({ source: 'corridors', id: idx }, { hover: true });
  }

  /** Highlight a route from outside the map (e.g. hovering the list). */
  hover(id: string | null) {
    if (!this.loaded) return;
    this.setHoverIdx(id ? (this.indexOf.get(id) ?? null) : null);
  }

  select(id: string | null) {
    this.selectedId = id;
    if (!this.loaded) return;
    if (this.selectedIdx != null) this.map.setFeatureState({ source: 'corridors', id: this.selectedIdx }, { selected: false });
    this.selectedIdx = id ? (this.indexOf.get(id) ?? null) : null;
    if (this.selectedIdx != null) this.map.setFeatureState({ source: 'corridors', id: this.selectedIdx }, { selected: true });
    // Dim everything else while one route is selected
    for (const [layer, base] of Object.entries(BASE_LAYERS)) {
      this.map.setPaintProperty(layer, 'line-opacity', id ? ['case', ['==', ['get', 'id'], id], base, base * 0.22] : base);
    }
    this.map.setPaintProperty('cor-arrows', 'icon-opacity', id ? ['case', ['==', ['get', 'id'], id], 1, 0.12] : ARROW_OPACITY);
    this.paintPulse(0.35);
  }

  // ---------- "ends soon" pulse ----------

  private paintPulse(level: number) {
    const id = this.selectedId;
    this.map.setPaintProperty('cor-pulse', 'line-opacity', id ? ['case', ['==', ['get', 'id'], id], level, level * 0.15] : level);
  }

  private startPulse() {
    if (!this.hasExpiring) {
      this.stop('pulse');
      return;
    }
    if (prefersReducedMotion()) {
      this.paintPulse(0.35);
      return;
    }
    if (this.anims.has('pulse')) return;
    let last = 0;
    this.play('pulse', (ts) => {
      if (!this.hasExpiring) return false;
      if (ts - last > 80) {
        // ~1.8 s breathing cycle, repainted ~12 times a second (cheap, and only while such trips are on screen)
        this.paintPulse(0.12 + 0.48 * (0.5 + 0.5 * Math.sin((ts / 1800) * 2 * Math.PI)));
        last = ts;
      }
      return true;
    });
  }

  // ---------- one animation loop ----------

  /** Run `step` every frame until it returns false. A new step with the same key replaces the old one. */
  private play(key: string, step: (ts: number) => boolean) {
    this.anims.set(key, step);
    if (!this.loopRaf && !document.hidden) this.loopRaf = requestAnimationFrame(this.frame);
  }

  private stop(key: string) {
    this.anims.delete(key);
  }

  private frame = (ts: number) => {
    this.loopRaf = 0;
    if (document.hidden) return; // picked up again on visibilitychange
    for (const [key, step] of [...this.anims]) {
      if (this.anims.get(key) !== step) continue; // replaced by an earlier step this frame
      let more = false;
      try {
        more = step(ts);
      } catch (err) {
        console.warn('[trip-map] animation stopped:', err);
      }
      if (!more && this.anims.get(key) === step) this.anims.delete(key);
    }
    if (this.anims.size) this.loopRaf = requestAnimationFrame(this.frame);
  };

  // ---------- direction glow on the selected trip ----------

  /**
   * A soft light that runs along the selected trip in the direction of travel, from your start through the
   * pick-up and drop-off to your destination when a trip plan is set. Pauses between passes; off with reduced motion.
   */
  setFlow(coords: [number, number][] | null) {
    const sig = coords && coords.length > 1 ? `${coords.length}|${coords[0]}|${coords[coords.length - 1]}` : '';
    if (sig === this.flowSig) return;
    this.flowSig = sig;
    this.flowCoords = sig ? coords : null;
    if (this.loaded) this.applyFlow();
  }

  /** Light at `head` (0 = start of the trip, 1 = end), or none. */
  private paintFlow(head: number | null) {
    this.map.setPaintProperty('flow-halo', 'line-gradient', head === null ? solid(0) : gradient(glow(head, 0.3, 0.6), [head]));
    this.map.setPaintProperty('flow-core', 'line-gradient', head === null ? solid(0) : gradient(glow(head, 0.2, 0.95), [head]));
  }

  private applyFlow() {
    (this.map.getSource('flow') as GeoJSONSource).setData({ type: 'FeatureCollection', features: this.flowCoords ? [lineFeature(this.flowCoords)] : [] });
    this.stop('flow');
    this.paintFlow(null);
    if (!this.flowCoords || prefersReducedMotion()) return;
    const t0 = performance.now();
    const pass = 2600;
    const rest = 1500;
    let last = 0;
    let resting = false;
    this.play('flow', (ts) => {
      const x = ((ts - t0) % (pass + rest)) / pass;
      if (x > 1) {
        if (!resting) this.paintFlow(null);
        resting = true;
        return true;
      }
      resting = false;
      if (ts - last < 33) return true; // ~30 frames a second is plenty for a soft glow
      last = ts;
      // start a little before the line and finish a little after it, so the light slides in and out
      this.paintFlow(-0.08 + easeInOut(x) * 1.16);
      return true;
    });
  }

  setData(corridors: Corridor[], stations: Station[], shapes: Shapes, keepChooser = false) {
    if (!this.loaded) return;
    if (!keepChooser) this.closeChooser();
    this.corridors = new Map(corridors.map((c) => [c.id, c]));
    this.stations = new Map(stations.map((s) => [s.code, s]));
    this.indexOf = new Map();
    // Draw upcoming routes first and available ones last so they sit on top. Within that, the site with the most
    // routes goes underneath, so a handful of DriveBack or Drive4Free trips aren't buried under Hertz's many.
    const perSite = new Map<string, number>();
    for (const c of corridors) perSite.set(c.provider, (perSite.get(c.provider) ?? 0) + 1);
    const ordered = [...corridors].sort((a, b) => b.rank - a.rank || perSite.get(b.provider)! - perSite.get(a.provider)! || a.carCount - b.carCount);
    const features = ordered.map((c, i) => {
      this.indexOf.set(c.id, i);
      return {
        type: 'Feature' as const,
        id: i,
        properties: (() => {
          const shade = shadeColors(c.provider, c.shade ?? 0);
          return { id: c.id, provider: c.provider, rank: c.rank, cars: c.carCount, expiring: c.expiresSoon, cNow: shade.now, cSoon: shade.soon, cLater: shade.later };
        })(),
        geometry: { type: 'LineString' as const, coordinates: lineFor(c, shapes) },
      };
    });
    this.map.removeFeatureState({ source: 'corridors' });
    (this.map.getSource('corridors') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    (this.map.getSource('stations') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: stations.map((s) => ({
        type: 'Feature' as const,
        properties: { code: s.code, provider: s.provider, place: s.place, short: s.short, out: s.outCars, in: s.inCars, hasNow: s.hasNow },
        geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
      })),
    });
    this.hoverIdx = null;
    this.selectedIdx = null;
    this.select(this.selectedId && this.corridors.has(this.selectedId) ? this.selectedId : null);
    this.hasExpiring = corridors.some((c) => c.expiresSoon && c.rank === 0);
    this.startPulse();
  }

  fitCorridor(c: Corridor, shapes: Shapes) {
    this.fit(boundsOf(lineFor(c, shapes)), 9);
  }

  fitStations(stations: Station[], maxZoom = 8) {
    if (!stations.length) return;
    this.fit(boundsOf(stations.map((s) => [s.lon, s.lat])), maxZoom);
  }

  private fit(b: [[number, number], [number, number]], maxZoom: number) {
    const { clientWidth: w, clientHeight: hgt } = this.map.getContainer();
    const p = { ...this.padding };
    // Never let the padding swallow the whole map
    if (p.left + p.right > w - 80) p.left = p.right = 40;
    if (p.top + p.bottom > hgt - 80) p.top = p.bottom = 40;
    this.map.fitBounds(b, { padding: p, maxZoom, duration: prefersReducedMotion() ? 0 : 700 });
  }
}

function emptyFc() {
  return { type: 'FeatureCollection' as const, features: [] };
}

/** White chevron on transparent background, tinted per layer via SDF. Points right = direction of travel. */
function chevronImage(): ImageData {
  const w = 28;
  const hgt = 28;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(10, 7);
  ctx.lineTo(17, 14);
  ctx.lineTo(10, 21);
  ctx.stroke();
  return ctx.getImageData(0, 0, w, hgt);
}

/**
 * Arrowhead pointing right (direction of travel) with a notched back, as a real signed distance field, so MapLibre can
 * fill it with any colour and draw an outline (halo) round it. Same convention as MapLibre's glyphs: the edge sits at
 * alpha 0.75 and the field spans 8 pixels.
 */
function arrowheadSdf(): { width: number; height: number; data: Uint8Array } {
  const size = 48;
  const poly: [number, number][] = [
    [38, 24], // tip
    [13, 10],
    [19, 24], // notch
    [13, 38],
  ];
  const segment = (px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const inside = (px: number, py: number) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let d = Infinity;
      for (let i = 0; i < poly.length; i++) d = Math.min(d, segment(px, py, poly[i], poly[(i + 1) % poly.length]));
      const alpha = Math.max(0, Math.min(1, 0.75 - (inside(px, py) ? -d : d) / 8));
      const k = (y * size + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(alpha * 255);
    }
  return { width: size, height: size, data };
}
