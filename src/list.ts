import { KIND_LABEL } from './carinfo';
import { h, plural } from './dom';
import { activeExtraFilters, defaultFilters, type Filters, type KindFilter, type SortKey, type When } from './filters';
import { fmtAgo, fmtSpan, fmtWhen } from './format';
import { createPlacePicker } from './placepicker';
import { planMode, type Place, type PlanMatch, type PlanMode } from './plan';
import { stationLabel } from './normalize';
import { setLineVars } from './shades';
import { PROVIDERS, PROVIDER_ORDER, isProvider } from './providers';
import type { Corridor, Model, ProviderId, ProviderStatus, Station } from './types';

const PLAN_KEY = 'hertz-planner.plan';
const RADIUS_LABEL: Record<PlanMode, [string, string]> = {
  near: ['Pick up within', 'of you'],
  arrive: ['Drop off within', 'of your destination'],
  route: ['Pick up and drop off within', 'of your route'],
};

function loadSavedPlan(): Partial<Filters> {
  try {
    const v = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
    if (!v || typeof v !== 'object') return {};
    const ok = (p: unknown): p is Place => !!p && typeof (p as Place).lat === 'number' && typeof (p as Place).lon === 'number' && typeof (p as Place).label === 'string';
    const providers = defaultFilters().providers;
    if (v.providers && typeof v.providers === 'object') for (const [k, on] of Object.entries(v.providers)) if (isProvider(k)) providers[k] = on !== false;
    return {
      fromPlace: ok(v.fromPlace) ? v.fromPlace : null,
      toPlace: ok(v.toPlace) ? v.toPlace : null,
      radiusKm: typeof v.radiusKm === 'number' ? Math.min(300, Math.max(5, v.radiusKm)) : 50,
      providers,
    };
  } catch {
    return {};
  }
}

function savePlan(f: Filters) {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify({ fromPlace: f.fromPlace, toPlace: f.toPlace, radiusKm: f.radiusKm, providers: f.providers }));
  } catch {
    /* storage unavailable: the plan just won't be remembered */
  }
}

export interface SidebarHandlers {
  onFiltersChange(f: Filters): void;
  onSelect(id: string): void;
  onHover(id: string | null): void;
  onRefresh(): void;
  onClearFocus(): void;
  /** a place was picked or cleared (the map re-centres on the plan) */
  onPlanPlacesChange(): void;
  onToggleAlerts(): void;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (d: Date | null) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : '');
const fromLocalInput = (v: string) => (v ? new Date(v) : null);

export class Sidebar {
  private filters: Filters = { ...defaultFilters(), ...loadSavedPlan() };
  private els!: {
    carsNow: HTMLElement;
    subline: HTMLElement;
    refresh: HTMLButtonElement;
    list: HTMLUListElement;
    shown: HTMLElement;
    extraCount: HTMLElement;
    focus: HTMLElement;
    planNote: HTMLElement;
    radius: HTMLElement;
    radiusLabel: HTMLElement;
    radiusOut: HTMLElement;
    sort: HTMLSelectElement;
    planOption: HTMLOptionElement;
    providers: HTMLElement;
    bell: HTMLButtonElement;
    swap: HTMLButtonElement;
  };
  private statuses: ProviderStatus[] = [];
  private alertsOn = false;
  private rows = new Map<string, HTMLButtonElement>();
  private lastFetched: Date | null = null;
  private model: Model | null = null;

  constructor(
    private root: HTMLElement,
    private handlers: SidebarHandlers,
  ) {
    if (planMode(this.filters.fromPlace, this.filters.toPlace)) this.filters.sort = 'plan';
    this.build();
    setInterval(() => this.updateAgo(), 30000);
  }

  /** Filters as they are now (used once at start-up, so a remembered trip plan applies straight away). */
  current(): Filters {
    return { ...this.filters, countries: { ...this.filters.countries } };
  }

  private emit() {
    this.els.extraCount.textContent = activeExtraFilters(this.filters) ? String(activeExtraFilters(this.filters)) : '';
    this.syncPlanControls();
    savePlan(this.filters);
    this.handlers.onFiltersChange(this.current());
  }

  /** Show the distance slider and "best match" sort only while a trip is being planned. */
  private syncPlanControls() {
    const f = this.filters;
    const mode = planMode(f.fromPlace, f.toPlace);
    this.els.radius.hidden = !mode;
    this.els.planOption.hidden = !mode;
    this.els.planOption.disabled = !mode;
    if (mode) {
      const [before, after] = RADIUS_LABEL[mode];
      this.els.radiusLabel.textContent = before;
      this.els.radiusOut.textContent = `${f.radiusKm} km ${after}`;
    }
    if (!mode && f.sort === 'plan') f.sort = 'status';
    this.els.sort.value = f.sort;
    this.els.swap.disabled = !mode; // nothing to swap until a place is picked
  }

  private placesChanged() {
    const f = this.filters;
    if (planMode(f.fromPlace, f.toPlace)) f.sort = 'plan';
    this.emit();
    this.handlers.onPlanPlacesChange();
  }

  /** Towns with pick-up points (averaged per town), for instant suggestions. */
  private localPlaces(): Place[] {
    if (!this.model) return [];
    const byPlace = new Map<string, Station[]>();
    for (const s of this.model.stations.values()) {
      if (!byPlace.has(s.place)) byPlace.set(s.place, []);
      byPlace.get(s.place)!.push(s);
    }
    return [...byPlace.entries()]
      .map(([label, list]) => ({
        label,
        detail: list.length === 1 ? `${PROVIDERS[list[0].provider].short}: ${list[0].short}` : `${list.length} pick-up points`,
        lat: list.reduce((a, s) => a + s.lat, 0) / list.length,
        lon: list.reduce((a, s) => a + s.lon, 0) / list.length,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'sv'));
  }

  private build() {
    const f = this.filters;
    const toggle = (label: string, key: 'automatic' | 'hideSummer', cls = '') => {
      const btn = h('button', { type: 'button', class: `toggle ${cls}`, 'aria-pressed': String(f[key]) }, h('span', { class: 'toggle-mark', 'aria-hidden': 'true' }), label);
      btn.addEventListener('click', () => {
        f[key] = !f[key];
        btn.setAttribute('aria-pressed', String(f[key]));
        this.emit();
      });
      return btn;
    };
    const country = (label: string, key: 'se' | 'no') => {
      const btn = h('button', { type: 'button', class: 'toggle', 'aria-pressed': String(f.countries[key]) }, h('span', { class: 'toggle-mark', 'aria-hidden': 'true' }), label);
      btn.addEventListener('click', () => {
        f.countries[key] = !f.countries[key];
        btn.setAttribute('aria-pressed', String(f.countries[key]));
        this.emit();
      });
      return btn;
    };
    const place = (label: string, key: 'from' | 'to', placeholder: string, locate: boolean, trailing: HTMLElement | null = null) =>
      createPlacePicker({
        id: `hp-${key}`,
        label,
        placeholder,
        value: key === 'from' ? f.fromPlace : f.toPlace,
        text: f[key],
        locate,
        trailing,
        localPlaces: () => this.localPlaces(),
        onText: (text) => {
          f[key] = text; // remembered, but only a picked place filters the trips
        },
        onPick: (p) => {
          if (key === 'from') f.fromPlace = p;
          else f.toPlace = p;
          if (p) f[key] = '';
          this.placesChanged();
        },
      }).el;

    const radiusInput = h('input', { type: 'range', min: '5', max: '300', step: '5', value: String(f.radiusKm), 'aria-label': 'How far you can travel to a car' });
    const radiusLabel = h('span', { class: 'field-label' });
    const radiusOut = h('output', { class: 'radius-out' });
    let radiusTimer = 0;
    radiusInput.addEventListener('input', () => {
      f.radiusKm = Number(radiusInput.value);
      this.syncPlanControls();
      clearTimeout(radiusTimer);
      radiusTimer = window.setTimeout(() => this.emit(), 120);
    });
    const radius = h('div', { class: 'radius', hidden: true }, h('p', { class: 'radius-head' }, radiusLabel, ' ', radiusOut), radiusInput);
    const planNote = h('div', { class: 'plan-note', hidden: true, 'aria-live': 'polite' });
    const kinds: [KindFilter, string][] = [
      ['any', 'Any'],
      ['electric', 'Electric'],
      ['plugin', 'Hybrid'],
      ['fuel', 'Petrol / diesel'],
    ];
    const kindGroup = h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-label': 'Car type' },
      kinds.map(([value, label]) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(f.kind === value), 'data-value': value }, label);
        b.addEventListener('click', () => {
          f.kind = value;
          kindGroup.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.value === value)));
          this.emit();
        });
        return b;
      }),
    );
    const leaveFrom = h('input', { type: 'datetime-local', 'aria-label': 'Earliest departure' });
    const leaveTo = h('input', { type: 'datetime-local', 'aria-label': 'Latest departure' });
    const onLeave = () => {
      f.leaveFrom = fromLocalInput(leaveFrom.value);
      f.leaveTo = fromLocalInput(leaveTo.value);
      this.emit();
    };
    leaveFrom.addEventListener('change', onLeave);
    leaveTo.addEventListener('change', onLeave);
    leaveFrom.value = toLocalInput(f.leaveFrom);
    leaveTo.value = toLocalInput(f.leaveTo);

    // When can you pick the car up? (a car fits if its pickup window overlaps the choice)
    const whens: [When, string][] = [
      ['any', 'Any time'],
      ['now', 'Now'],
      ['today', 'Today'],
      ['tomorrow', 'Tomorrow'],
      ['weekend', 'Weekend'],
    ];
    const whenGroup = h(
      'div',
      { class: 'segmented when', role: 'radiogroup', 'aria-labelledby': 'hp-when-label' },
      whens.map(([value, label]) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(f.when === value), 'data-value': value }, label);
        b.addEventListener('click', () => {
          f.when = value;
          whenGroup.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.value === value)));
          this.emit();
        });
        return b;
      }),
    );
    const providerChips = h('div', { class: 'provider-chips' });

    const sort = h(
      'select',
      { 'aria-label': 'Sort routes' },
      ([
        ['plan', 'Best for my trip'],
        ['status', 'Available first'],
        ['expiry', 'Ending soonest'],
        ['cars', 'Most cars'],
        ['distance', 'Longest drive'],
      ] as [SortKey, string][]).map(([v, label]) => h('option', { value: v }, label)),
    );
    sort.addEventListener('change', () => {
      f.sort = sort.value as SortKey;
      this.emit();
    });

    const refresh = h('button', { type: 'button', class: 'icon-btn refresh', 'aria-label': 'Refresh trips', title: 'Refresh trips', onclick: () => this.handlers.onRefresh() }, refreshIcon());
    // Turn the trip around: From becomes To and To becomes From
    const swap = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn swap',
        'aria-label': 'Swap From and To',
        title: 'Swap From and To (the same trip the other way)',
        disabled: !f.fromPlace && !f.toPlace,
        onclick: () => this.swapPlaces(),
      },
      swapIcon(),
    );
    const bell = h(
      'button',
      {
        type: 'button',
        class: 'icon-btn bell',
        'aria-pressed': String(this.alertsOn),
        'aria-label': 'Alert me about new trips that match my filters',
        title: 'Alert me about new trips that match my filters',
        onclick: () => this.handlers.onToggleAlerts(),
      },
      bellIcon(),
    );
    const extraCount = h('span', { class: 'count-badge', 'aria-label': 'active filters' });
    const list = h('ul', { class: 'route-list', id: 'route-list' });
    list.addEventListener('mouseleave', () => this.handlers.onHover(null));

    const sheetToggle = h('button', { type: 'button', class: 'sheet-handle', 'aria-label': 'Show or hide the trip list', 'aria-expanded': 'false' });
    sheetToggle.addEventListener('click', () => {
      const open = this.root.classList.toggle('open');
      sheetToggle.setAttribute('aria-expanded', String(open));
    });

    const form = h(
      'form',
      { class: 'filters', onsubmit: (e: Event) => e.preventDefault() },
      h('div', { class: 'places' }, place('From', 'from', 'Where are you?', true), place('To', 'to', 'Anywhere', false, swap)),
      radius,
      h('div', { class: 'when-row' }, h('span', { class: 'field-label', id: 'hp-when-label' }, 'When'), whenGroup),
      h('div', { class: 'provider-row', role: 'group', 'aria-label': 'Sites to show' }, providerChips),
      h(
        'details',
        { class: 'more-filters' },
        h('summary', null, 'More filters', extraCount),
        h('div', { class: 'filter-block' }, h('p', { class: 'filter-label' }, 'Car type'), kindGroup),
        h('div', { class: 'filter-block toggles' }, toggle('Automatic only', 'automatic'), toggle('Hide summer-tyre cars', 'hideSummer')),
        h('div', { class: 'filter-block' }, h('p', { class: 'filter-label' }, 'Pick up in'), h('div', { class: 'toggles' }, country('Sweden', 'se'), country('Norway', 'no'))),
        h(
          'div',
          { class: 'filter-block' },
          h('p', { class: 'filter-label' }, 'I can leave between'),
          h('div', { class: 'leave' }, leaveFrom, h('span', { class: 'muted' }, 'and'), leaveTo),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn-ghost',
            onclick: () => this.reset(),
          },
          'Reset filters',
        ),
      ),
    );
    const focus = h('div', { class: 'focus-note', hidden: true });

    const carsNow = h('strong', null, '–');
    const subline = h('p', { class: 'subline' }, 'Loading trips from Hertz Freerider, DriveBack and Drive4Free…');
    this.root.replaceChildren(
      sheetToggle,
      h(
        'header',
        { class: 'side-head' },
        h('div', { class: 'brand' }, logo(), h('h1', null, 'Free car trips'), bell, refresh),
        h('p', { class: 'headline' }, carsNow, h('span', null, ' cars you can take right now')),
        subline,
      ),
      form,
      planNote,
      focus,
      h('div', { class: 'list-head' }, h('p', { class: 'shown', 'aria-live': 'polite' }), h('label', { class: 'sort' }, h('span', null, 'Sort'), sort)),
      list,
    );
    this.els = {
      carsNow,
      subline,
      refresh,
      list,
      shown: this.root.querySelector('.shown') as HTMLElement,
      extraCount,
      focus,
      planNote,
      radius,
      radiusLabel,
      radiusOut,
      sort,
      planOption: sort.querySelector('option[value="plan"]') as HTMLOptionElement,
      providers: providerChips,
      bell,
      swap,
    };
    this.renderProviders();
    this.syncPlanControls();
  }

  /** Provider toggles: colour dot, name and how many cars each site has right now. */
  private renderProviders() {
    const f = this.filters;
    const byProvider = this.model?.byProvider;
    this.els.providers.replaceChildren(
      ...PROVIDER_ORDER.map((id: ProviderId) => {
        const meta = PROVIDERS[id];
        const st = this.statuses.find((x) => x.id === id);
        const cars = byProvider?.[id]?.cars ?? 0;
        let state = '';
        let title = `${meta.name}: ${plural(cars, 'car', 'cars')}. Click to ${f.providers[id] ? 'hide' : 'show'} these trips.`;
        if (st?.loading) {
          state = 'loading';
          title = `${meta.name}: loading trips…`;
        } else if (st?.error && !st.stale) {
          state = 'error';
          title = `${meta.name} couldn't be reached (${st.error}).`;
        } else if (st?.stale) {
          state = 'stale';
          title = `${meta.name} didn't answer the last check, so these are its trips from ${st.fetchedAt ? fmtAgo(new Date(st.fetchedAt)) : 'earlier'}.`;
        }
        if (st?.unplaced) title += ` ${plural(st.unplaced, 'trip', 'trips')} couldn't be placed on the map.`;
        const btn = h(
          'button',
          { type: 'button', class: `pchip${state ? ` ${state}` : ''}`, 'data-provider': id, 'aria-pressed': String(f.providers[id]), title },
          h('span', { class: 'pchip-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'pchip-name' }, meta.short),
          h('span', { class: 'pchip-count' }, state === 'loading' ? '…' : state === 'error' ? '!' : String(cars)),
        );
        btn.addEventListener('click', () => {
          f.providers[id] = !f.providers[id];
          btn.setAttribute('aria-pressed', String(f.providers[id]));
          this.emit();
        });
        return btn;
      }),
    );
  }

  setProviders(statuses: ProviderStatus[]) {
    this.statuses = statuses;
    this.renderProviders();
  }

  setAlerts(on: boolean) {
    this.alertsOn = on;
    this.els.bell.setAttribute('aria-pressed', String(on));
    this.els.bell.title = on
      ? 'Alerts are on: you get a notification when a new trip matches your filters (keep this tab open). Click to turn off.'
      : 'Alert me about new trips that match my filters';
  }

  /** One line under the filters describing the trip being planned. `busy`: the road is still being looked up. */
  setPlanNote(text: string | null, busy = false) {
    const el = this.els.planNote;
    el.hidden = !text;
    el.classList.toggle('busy', busy);
    if (!text) return;
    el.replaceChildren(
      h('span', null, text),
      h(
        'button',
        {
          type: 'button',
          class: 'link',
          onclick: () => {
            this.filters.fromPlace = null;
            this.filters.toPlace = null;
            this.filters.from = '';
            this.filters.to = '';
            this.rebuild();
            this.placesChanged();
          },
        },
        'Clear trip',
      ),
    );
  }

  /** From becomes To and To becomes From, then the road is looked up again in the new direction. */
  private swapPlaces() {
    const f = this.filters;
    [f.fromPlace, f.toPlace] = [f.toPlace, f.fromPlace];
    [f.from, f.to] = [f.to, f.from];
    this.rebuild();
    const btn = this.root.querySelector<HTMLButtonElement>('.swap');
    btn?.classList.add('turned'); // half a turn, so you see it happen
    btn?.focus({ preventScroll: true });
    this.placesChanged();
  }

  /** Make the trip plan wider (from the "no trips" message). */
  private widen() {
    this.filters.radiusKm = Math.min(300, this.filters.radiusKm * 2);
    this.rebuild();
    this.emit();
  }

  private rebuild() {
    const keepSort = this.filters.sort;
    this.build();
    this.filters.sort = keepSort;
    if (this.model) this.setStats(this.model, this.lastFetched);
  }

  private reset() {
    const keep = { sort: this.filters.sort, fromPlace: this.filters.fromPlace, toPlace: this.filters.toPlace, radiusKm: this.filters.radiusKm };
    this.filters = { ...defaultFilters(), ...keep };
    this.rebuild();
    this.emit();
    this.handlers.onClearFocus();
  }

  setLoading(loading: boolean) {
    this.els.refresh.classList.toggle('spinning', loading);
    this.els.refresh.disabled = loading;
  }

  setStats(model: Model, fetchedAt: Date | null) {
    this.lastFetched = fetchedAt;
    this.model = model;
    this.els.carsNow.textContent = String(model.totals.carsNow);
    this.updateAgo();
    this.renderProviders();
  }

  private updateAgo() {
    if (!this.model) return;
    const t = this.model.totals;
    this.els.subline.textContent = `${plural(t.cars, 'car', 'cars')} on ${plural(t.routes, 'route', 'routes')} in total. ${this.lastFetched ? `Updated ${fmtAgo(this.lastFetched)}.` : ''}`;
  }

  showError(message: string) {
    this.els.subline.textContent = message;
  }

  setFocus(station: Station | null) {
    const el = this.els.focus;
    el.hidden = !station;
    if (station) {
      el.replaceChildren(
        h('span', null, 'Showing trips to and from ', h('strong', null, stationLabel(station))),
        h('button', { type: 'button', class: 'link', onclick: () => this.handlers.onClearFocus() }, 'Show all'),
      );
    }
  }

  /** `searching`: the road for the trip plan is still being looked up, so the list shows placeholders. */
  setList(corridors: Corridor[], newIds: Set<string>, selected: string | null, now: Date, matches: Map<string, PlanMatch> = new Map(), searching = false) {
    this.rows.clear();
    if (searching) {
      this.els.shown.textContent = 'Searching…';
      this.els.list.replaceChildren(
        h('li', { class: 'searching-note', role: 'status' }, 'Finding trips along your road…'),
        ...[0, 1, 2].map((i) => h('li', { class: 'skeleton', 'aria-hidden': 'true', style: { animationDelay: `${i * 0.12}s` } }, h('span', { class: 'sk-stripe' }), h('span', { class: 'sk-lines' }, h('i'), h('i'), h('i')))),
      );
      return;
    }
    const cars = new Set(corridors.flatMap((c) => c.cars.map((x) => x.offerId))).size;
    this.els.shown.textContent = `${plural(corridors.length, 'route', 'routes')} with ${plural(cars, 'car', 'cars')}`;
    if (!corridors.length) {
      const mode = planMode(this.filters.fromPlace, this.filters.toPlace);
      const canWiden = !!mode && this.filters.radiusKm < 300;
      this.els.list.replaceChildren(
        h(
          'li',
          { class: 'empty' },
          h('p', null, mode ? `No trips fit within ${this.filters.radiusKm} km right now.` : 'No trips match these filters.'),
          canWiden
            ? h('button', { type: 'button', class: 'btn-ghost', onclick: () => this.widen() }, `Search within ${Math.min(300, this.filters.radiusKm * 2)} km`)
            : h('button', { type: 'button', class: 'btn-ghost', onclick: () => this.reset() }, 'Reset filters'),
        ),
      );
      return;
    }
    this.els.list.replaceChildren(
      ...corridors.map((c) => {
        const btn = h(
          'button',
          {
            type: 'button',
            class: `route-row status-${c.status}${c.expiresSoon ? ' expiring' : ''}${c.id === selected ? ' selected' : ''}`,
            'data-provider': c.provider,
            'aria-current': c.id === selected ? 'true' : null,
            onclick: () => this.handlers.onSelect(c.id),
            onmouseenter: () => this.handlers.onHover(c.id),
            onfocus: () => this.handlers.onHover(c.id),
          },
          h('span', { class: 'stripe', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'route-main' },
            h('span', { class: 'route-title' }, `${c.from.place} → ${c.to.place}`),
            h('span', { class: 'route-sub' }, `${c.from.short} to ${c.to.short}`),
            h('span', { class: 'route-when' }, whenLine(c, now)),
            matches.has(c.id) ? h('span', { class: 'route-plan' }, planLine(matches.get(c.id)!)) : null,
            badges(c, newIds.has(c.id)),
          ),
          h('span', { class: 'route-count' }, h('strong', null, String(c.carCount)), h('span', null, c.carCount === 1 ? 'car' : 'cars')),
        );
        setLineVars(btn, c.provider, c.shade); // the stripe matches the line's shade on the map
        this.rows.set(c.id, btn);
        return h('li', null, btn);
      }),
    );
  }

  highlight(id: string | null) {
    this.rows.forEach((row, rid) => row.classList.toggle('hovered', rid === id));
  }

  markSelected(id: string | null, scroll = true) {
    this.rows.forEach((row, rid) => {
      row.classList.toggle('selected', rid === id);
      if (rid === id) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    });
    // Scroll only the list itself; scrollIntoView would also scroll the page on mobile.
    const row = id && scroll ? this.rows.get(id) : undefined;
    const list = this.els.list;
    if (row && list.clientHeight > 0) {
      const r = row.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      if (r.top < l.top) list.scrollTop -= l.top - r.top + 8;
      else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom + 8;
    }
  }
}

function whenLine(c: Corridor, now: Date): string {
  if (c.status === 'now') {
    const left = c.soonestExpiry.getTime() - now.getTime();
    return c.expiresSoon ? `Available now, ends in ${fmtSpan(left)}` : `Available now, ends ${fmtWhen(c.soonestExpiry, now)}`;
  }
  return `Opens ${fmtWhen(c.earliestFrom, now)}`;
}

const km = (n: number) => `${n < 10 ? n.toFixed(1).replace(/\.0$/, '') : Math.round(n)} km`;

function planLine(m: PlanMatch): string {
  if (m.mode === 'near') return m.pickupKm < 2 ? 'Pick-up right by you' : `Pick-up ${km(m.pickupKm)} from you`;
  if (m.mode === 'arrive') return m.dropoffToDestKm! < 2 ? 'Drops you right at your destination' : `Drop-off ${km(m.dropoffToDestKm!)} from your destination`;
  const off = Math.max(m.pickupKm, m.dropoffOffKm ?? 0);
  return `Car covers ${km(m.carKm!)} of your trip${off >= 2 ? `, up to ${km(off)} off your route` : ''}`;
}

function badges(c: Corridor, isNew: boolean) {
  const items: HTMLElement[] = [h('span', { class: 'ptag', 'data-provider': c.provider }, PROVIDERS[c.provider].short)];
  if (isNew) items.push(h('span', { class: 'badge badge-new' }, 'New'));
  for (const k of c.kinds) if (k === 'electric' || k === 'plugin') items.push(h('span', { class: `badge kind-${k}` }, KIND_LABEL[k]));
  if (c.cars.some((x) => x.tags.some((t) => t.label === 'Summer tyres'))) items.push(h('span', { class: 'badge badge-warn' }, 'Summer tyres'));
  return items.length ? h('span', { class: 'badges' }, items) : null;
}

function logo() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('class', 'logo');
  svg.setAttribute('aria-hidden', 'true');
  // One road in all three sites' colours
  const [a, b, c] = PROVIDER_ORDER.map((id) => PROVIDERS[id].colors.now);
  svg.innerHTML =
    `<defs><linearGradient id="logo-road" x1="6" y1="24" x2="26" y2="8" gradientUnits="userSpaceOnUse"><stop offset="0.1" stop-color="${a}"/><stop offset="0.5" stop-color="${b}"/><stop offset="0.9" stop-color="${c}"/></linearGradient></defs>` +
    '<path d="M6 24 C 12 22, 14 10, 26 8" fill="none" stroke="url(#logo-road)" stroke-width="3.2" stroke-linecap="round"/><circle cx="6" cy="24" r="3" fill="#ece8df"/><circle cx="26" cy="8" r="3" fill="#ece8df"/>';
  return svg;
}

function swapIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M8 19V5M8 5l-3.5 3.5M8 5l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 5v14M16 19l-3.5-3.5M16 19l3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}
function bellIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  return svg;
}

function refreshIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M20 11a8 8 0 1 0-2.3 5.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}
