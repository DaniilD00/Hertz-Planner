import { KIND_LABEL } from './carinfo';
import { h, plural } from './dom';
import { fmtHours, fmtMinutes, fmtSpan, fmtTime, fmtWhen, TZ, WEEKDAYS, weekdayIndex } from './format';
import { haversineKm, transitLink, type Place, type PlanMatch } from './plan';
import { stationHeading, stationLabel } from './normalize';
import { PROVIDERS } from './providers';
import { setLineVars } from './shades';
import type { CarOffer, Corridor, Station } from './types';

export interface PanelPlan {
  match: PlanMatch;
  from: Place | null;
  to: Place | null;
  totalKm: number | null;
  byRoad: boolean;
}

export interface PanelHandlers {
  onClose(): void;
  onSelectCorridor(id: string): void;
  onSelectStation(code: string): void;
}

function closeButton(onClose: () => void) {
  return h('button', { type: 'button', class: 'icon-btn panel-close', 'aria-label': 'Close details', onclick: onClose }, '×');
}

function statusLine(c: Corridor, now: Date) {
  if (c.status === 'now') {
    const left = c.soonestExpiry.getTime() - now.getTime();
    return c.expiresSoon ? `Available now. The first pickup window ends in ${fmtSpan(left)}.` : 'Available now';
  }
  return `Opens ${fmtWhen(c.earliestFrom, now)}, in ${fmtSpan(c.earliestFrom.getTime() - now.getTime())}`;
}

const providerTag = (c: { provider: Corridor['provider'] }) => h('span', { class: 'ptag', 'data-provider': c.provider }, PROVIDERS[c.provider].name);

/**
 * @param road distance and time of the road shape, used when the provider doesn't give its own estimate
 */
export function renderCorridorPanel(
  el: HTMLElement,
  c: Corridor,
  now: Date,
  handlers: PanelHandlers,
  focus = true,
  plan: PanelPlan | null = null,
  road: { km?: number; min?: number } | null = null,
) {
  const meta = PROVIDERS[c.provider];
  const km = c.estKm ?? road?.km ?? null;
  const min = c.estMin ?? road?.min ?? null;
  const drive = km != null ? `About ${km} km${min != null ? `, ${fmtMinutes(min)} of driving` : ''}.` : '';
  // One booking link for the whole route if every car shares it (Hertz); otherwise each car gets its own (DriveBack)
  const urls = new Set(c.cars.map((x) => x.bookUrl));
  const sharedUrl = urls.size === 1 ? [...urls][0] : meta.site;
  el.replaceChildren(
    h(
      'div',
      { class: 'panel-head', 'data-provider': c.provider },
      closeButton(handlers.onClose),
      providerTag(c),
      h('p', { class: `panel-status status-${c.status}${c.expiresSoon ? ' expiring' : ''}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), statusLine(c, now)),
      h('h2', { class: 'panel-title', tabindex: '-1' }, h('span', null, c.from.place), h('span', { class: 'arrow', 'aria-label': 'to' }, ' → '), h('span', null, c.to.place)),
      h('p', { class: 'panel-sub' }, `${c.from.short} to ${c.to.short}`),
      h('p', { class: 'panel-meta' }, `${plural(c.carCount, 'car', 'cars')} on this route. ${drive}`),
    ),
    ...(plan ? [renderTripPlan(c, plan)] : []),
    h(
      'section',
      { class: 'panel-section', 'aria-label': 'Cars', 'data-provider': c.provider },
      h('ol', { class: 'cars' }, c.cars.map((car) => h('li', null, renderCar(car, now, handlers, c, urls.size > 1)))),
      meta.notes.length ? h('ul', { class: 'provider-notes' }, meta.notes.map((n) => h('li', null, n))) : null,
    ),
    h(
      'section',
      { class: 'panel-section stations', 'aria-label': 'Stations' },
      renderStation('Pick up at', c.from, now, handlers),
      renderStation('Drop off at', c.to, now, handlers),
    ),
    h(
      'div',
      { class: 'panel-foot', 'data-provider': c.provider },
      h('a', { class: 'btn-primary', href: sharedUrl, target: '_blank', rel: 'noopener noreferrer' }, urls.size === 1 ? meta.bookLabel : `Open ${meta.siteLabel}`),
      h('p', { class: 'muted small' }, `${meta.bookNote} Bookings can’t be made from this map.`),
    ),
  );
  if (focus) (el.querySelector('.panel-title') as HTMLElement | null)?.focus({ preventScroll: true });
}

const kmText = (n: number) => `${n < 10 ? n.toFixed(1).replace(/\.0$/, '') : Math.round(n)} km`;
const placeName = (p: Place) => (p.label === 'My location' ? 'where you are' : p.label);

/** Step-by-step: get to the car by train or bus, drive, then continue to where you're going. */
function renderTripPlan(c: Corridor, plan: PanelPlan) {
  const { match: m, from, to } = plan;
  const steps: HTMLElement[] = [];
  const link = (a: { lat: number; lon: number }, b: { lat: number; lon: number }, text: string) =>
    h('a', { class: 'leg-link', href: transitLink(a, b), target: '_blank', rel: 'noopener noreferrer' }, text);

  if (from) {
    const near = m.mode === 'near' ? m.pickupKm : haversine(from, c.from);
    const close = near < 1;
    const detail = close
      ? m.mode === 'route'
        ? 'Right by your starting point.'
        : 'Right by you.'
      : m.mode === 'route' && m.pickupAlongKm! >= 5
        ? `About ${kmText(m.pickupAlongKm!)} into your trip${m.pickupKm >= 2 ? `, ${kmText(m.pickupKm)} off your route` : ''}. Roughly ${kmText(near)} from ${placeName(from)} as the crow flies.`
        : `About ${kmText(near)} from ${placeName(from)} as the crow flies.`;
    steps.push(
      h(
        'li',
        { class: 'leg leg-transit' },
        h('p', { class: 'leg-title' }, `Get to ${c.from.short}`),
        h('p', { class: 'leg-detail' }, detail),
        close ? null : link(from, c.from, 'Train and bus directions'),
      ),
    );
  }

  const carText =
    m.mode === 'route' && m.carKm != null
      ? `The car covers about ${kmText(m.carKm)} of your ${plan.totalKm ? kmText(plan.totalKm) : ''} trip${plan.byRoad ? '' : ' (straight-line estimate)'}.`
      : c.estKm != null
        ? `About ${c.estKm} km and ${fmtMinutes(c.estMin)} of driving.`
        : `Drive the ${PROVIDERS[c.provider].short} car to its drop-off.`;
  steps.push(h('li', { class: 'leg leg-drive' }, h('p', { class: 'leg-title' }, `Drive to ${c.to.short}`), h('p', { class: 'leg-detail' }, carText)));

  if (to) {
    const left = m.dropoffToDestKm ?? haversine(to, c.to);
    steps.push(
      h(
        'li',
        { class: 'leg leg-transit' },
        h('p', { class: 'leg-title' }, left < 1 ? `You're at ${to.label}` : `Continue to ${to.label}`),
        h('p', { class: 'leg-detail' }, left < 1 ? 'The drop-off is right by your destination.' : `About ${kmText(left)} from the drop-off as the crow flies.`),
        left < 1 ? null : link(c.to, to, 'Train and bus directions'),
      ),
    );
  }

  return h(
    'section',
    { class: 'panel-section trip-plan', 'aria-label': 'Your trip', 'data-provider': c.provider },
    h('h3', { class: 'section-title' }, 'Your trip'),
    h('ol', { class: 'legs' }, steps),
  );
}

const haversine = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => haversineKm(a.lat, a.lon, b.lat, b.lon);

function renderCar(car: CarOffer, now: Date, handlers: PanelHandlers, c: Corridor, ownLink: boolean) {
  const meta = PROVIDERS[car.provider];
  const chips = [
    car.kind !== 'unknown' ? h('span', { class: `chip kind-${car.kind}` }, KIND_LABEL[car.kind]) : null,
    car.transmission ? h('span', { class: 'chip' }, car.transmission) : null,
    car.awd ? h('span', { class: 'chip' }, 'AWD') : null,
    ...car.tags.map((t) => h('span', { class: `chip${t.tone === 'warn' ? ' chip-warn' : ''}` }, t.label)),
  ];
  const opensIn = car.availableFrom.getTime() - now.getTime();
  const endsIn = car.offerExpires.getTime() - now.getTime();
  const limits = [
    car.maxKm != null ? h('div', null, h('dt', null, 'Max distance'), h('dd', null, `${car.maxKm} km`)) : null,
    car.maxMin != null ? h('div', null, h('dt', null, 'Max driving time'), h('dd', null, fmtMinutes(car.maxMin))) : null,
    ...car.terms.map((t) => h('div', null, h('dt', null, t.label), h('dd', null, t.value))),
  ].filter((x): x is HTMLDivElement => !!x);
  return h(
    'article',
    { class: `car status-${car.status}` },
    h('h3', { class: 'car-model' }, car.modelLabel),
    h('div', { class: 'chips' }, chips),
    renderTimeline(car, now),
    h(
      'dl',
      { class: 'times' },
      h('div', null, h('dt', null, 'Available from'), h('dd', null, fmtWhen(car.availableFrom, now), h('span', { class: 'rel' }, opensIn > 0 ? `in ${fmtSpan(opensIn)}` : 'open now'))),
      h('div', null, h('dt', null, meta.expiresLabel), h('dd', null, fmtWhen(car.offerExpires, now), h('span', { class: 'rel' }, `${fmtSpan(endsIn)} left`))),
      car.returnBy ? h('div', null, h('dt', null, 'Return by'), h('dd', null, fmtWhen(car.returnBy, now))) : null,
    ),
    limits.length ? h('dl', { class: 'limits' }, limits) : null,
    car.notes.length ? h('p', { class: 'note' }, `Note from ${meta.short}: `, h('q', null, car.notes.join('; '))) : null,
    car.alsoOfferedTo.length
      ? h(
          'p',
          { class: 'shared' },
          'This car is also offered to ',
          car.alsoOfferedTo.map((s, i) => [
            i ? (i === car.alsoOfferedTo.length - 1 ? ' and ' : ', ') : '',
            h('button', { type: 'button', class: 'link', onclick: () => handlers.onSelectCorridor(`${c.from.code}>${s.code}`) }, stationLabel(s)),
          ]),
          '. Booking one destination removes the others.',
        )
      : null,
    ownLink ? h('a', { class: 'car-book', href: car.bookUrl, target: '_blank', rel: 'noopener noreferrer' }, meta.bookLabel) : null,
  );
}

/** Bar from now (or opening) to the end of the pickup window, or the return deadline if there is one. */
function renderTimeline(car: CarOffer, now: Date) {
  const start = Math.min(now.getTime(), car.availableFrom.getTime());
  const end = Math.max(car.returnBy?.getTime() ?? 0, car.offerExpires.getTime(), start + 3600e3);
  const span = end - start;
  const pct = (t: number) => `${(((Math.min(Math.max(t, start), end) - start) / span) * 100).toFixed(2)}%`;
  const ticks: HTMLElement[] = [];
  const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
  const startHour = Math.ceil(start / 3600e3) * 3600e3;
  const days = span / 864e5;
  for (let t = startHour; t < end; t += 3600e3) {
    if (hourFmt.format(t) === '00') {
      ticks.push(h('span', { class: 'tick', style: { left: pct(t) } }, days <= 9 ? h('span', null, dayFmt.format(t)) : null));
    }
  }
  const openLeft = pct(car.availableFrom.getTime());
  const openRight = pct(car.offerExpires.getTime());
  const label = `Pickup window from ${fmtWhen(car.availableFrom, now)} until ${fmtWhen(car.offerExpires, now)}${car.returnBy ? `, return by ${fmtWhen(car.returnBy, now)}` : ''}`;
  return h(
    'div',
    { class: 'timeline', role: 'img', 'aria-label': label },
    h(
      'div',
      { class: 'track' },
      h('span', { class: 'seg seg-open', style: { left: openLeft, width: `calc(${openRight} - ${openLeft})` } }),
      car.returnBy ? h('span', { class: 'seg seg-return', style: { left: openRight, right: '0' } }) : null,
      ...ticks,
      now.getTime() >= start && now.getTime() <= end ? h('span', { class: 'now-mark', style: { left: pct(now.getTime()) } }, h('span', null, 'now')) : null,
    ),
    h(
      'div',
      { class: 'timeline-legend' },
      h('span', { class: 'lg lg-open' }, 'Pickup window'),
      car.returnBy ? h('span', { class: 'lg lg-return' }, 'Until return deadline') : null,
    ),
  );
}

function precisionNote(s: Station) {
  if (s.precision === 'exact') return null;
  return h(
    'p',
    { class: 'approx' },
    s.precision === 'address'
      ? 'Map position looked up from the street address. Check the address before you go.'
      : `Only the town is known for sure, so the dot sits in ${s.place}. Check the address before you go.`,
  );
}

function renderStation(label: string, s: Station, now: Date, handlers: PanelHandlers) {
  const today = weekdayIndex(now);
  const heading = stationHeading(s);
  const info = [
    s.info.location ? ['Finding the key', s.info.location] : null,
    s.info.parking ? ['Where the car is parked', s.info.parking] : null,
    s.info.return ? ['Returning the car', s.info.return] : null,
    s.info.dropOff ? ['Drop-off', s.info.dropOff] : null,
    s.info.misc ? ['Other', s.info.misc] : null,
  ].filter((x): x is string[] => !!x);
  const hours = s.hours;
  const mapsLink = h(
    'a',
    {
      href: s.precision === 'exact' || !s.address ? `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}`,
      target: '_blank',
      rel: 'noopener noreferrer',
    },
    'Open in Google Maps',
  );
  return h(
    'div',
    { class: 'station' },
    h('p', { class: 'station-label' }, label),
    h('h3', null, h('button', { type: 'button', class: 'link station-name', onclick: () => handlers.onSelectStation(s.code) }, heading.title)),
    heading.sub ? h('p', { class: 'muted' }, heading.sub) : null,
    precisionNote(s),
    s.phone ? h('p', null, h('a', { href: `tel:${s.phone.replace(/[^\d+]/g, '')}` }, s.phone)) : null,
    hours ? h('p', null, `Open today: ${fmtHours(hours[today] ?? null)}`) : null,
    s.kiosk ? h('p', { class: 'kiosk' }, 'Self-service kiosk: you can get the key outside opening hours.') : null,
    hours || info.length
      ? h(
          'details',
          { class: 'more' },
          h('summary', null, hours ? 'Opening hours and directions' : 'Directions'),
          hours
            ? h(
                'table',
                { class: 'hours' },
                h(
                  'tbody',
                  null,
                  WEEKDAYS.map((d, i) => h('tr', { class: i === today ? 'today' : null }, h('th', { scope: 'row' }, d), h('td', null, fmtHours(hours[i] ?? null)))),
                ),
              )
            : null,
          info.map(([title, text]) => h('div', { class: 'info' }, h('h4', null, title), h('p', null, text))),
          h('p', null, mapsLink),
        )
      : h('p', null, mapsLink),
  );
}

export function renderStationPanel(
  el: HTMLElement,
  s: Station,
  outgoing: Corridor[],
  incoming: Corridor[],
  now: Date,
  handlers: PanelHandlers & { onShowAll(): void },
  focus = true,
) {
  const row = (c: Corridor, other: Station) =>
    h(
      'li',
      null,
      setLineVars(
        h(
          'button',
          { type: 'button', class: `route-row status-${c.status}${c.expiresSoon ? ' expiring' : ''}`, 'data-provider': c.provider, onclick: () => handlers.onSelectCorridor(c.id) },
          h('span', { class: 'stripe', 'aria-hidden': 'true' }),
          h('span', { class: 'route-main' }, h('span', { class: 'route-title' }, other.place), h('span', { class: 'route-sub' }, c.status === 'now' ? 'Available now' : `Opens ${fmtWhen(c.earliestFrom, now)}`)),
          h('span', { class: 'route-count' }, h('strong', null, String(c.carCount)), h('span', null, c.carCount === 1 ? 'car' : 'cars')),
        ),
        c.provider,
        c.shade,
      ),
    );
  el.replaceChildren(
    h(
      'div',
      { class: 'panel-head', 'data-provider': s.provider },
      closeButton(handlers.onClose),
      providerTag(s),
      h('h2', { class: 'panel-title', tabindex: '-1' }, stationHeading(s).title),
      stationHeading(s).sub ? h('p', { class: 'panel-sub' }, stationHeading(s).sub) : null,
      h('p', { class: 'panel-meta' }, `${plural(s.outCars, 'car leaves', 'cars leave')} from here and ${plural(s.inCars, 'arrives', 'arrive')}.`),
      h('button', { type: 'button', class: 'btn-ghost', onclick: handlers.onShowAll }, 'Show all trips again'),
    ),
    h(
      'section',
      { class: 'panel-section' },
      h('h3', { class: 'section-title' }, 'Trips from here'),
      outgoing.length ? h('ul', { class: 'route-list' }, outgoing.map((c) => row(c, c.to))) : h('p', { class: 'muted' }, 'No trips leave from here with the current filters.'),
    ),
    ...(incoming.length
      ? [h('section', { class: 'panel-section' }, h('h3', { class: 'section-title' }, 'Trips ending here'), h('ul', { class: 'route-list' }, incoming.map((c) => row(c, c.from))))]
      : []),
    h('section', { class: 'panel-section stations' }, renderStationDetails(s, now)),
  );
  if (focus) (el.querySelector('.panel-title') as HTMLElement | null)?.focus({ preventScroll: true });
}

function renderStationDetails(s: Station, now: Date) {
  const today = weekdayIndex(now);
  const hours = s.hours;
  return h(
    'div',
    { class: 'station' },
    precisionNote(s),
    s.phone ? h('p', null, h('a', { href: `tel:${s.phone.replace(/[^\d+]/g, '')}` }, s.phone)) : null,
    s.kiosk ? h('p', { class: 'kiosk' }, 'Self-service kiosk: you can get the key outside opening hours.') : null,
    hours
      ? h(
          'table',
          { class: 'hours' },
          h(
            'tbody',
            null,
            WEEKDAYS.map((d, i) => h('tr', { class: i === today ? 'today' : null }, h('th', { scope: 'row' }, d), h('td', null, fmtHours(hours[i] ?? null)))),
          ),
        )
      : null,
    s.info.location ? h('div', { class: 'info' }, h('h4', null, 'Finding the key'), h('p', null, s.info.location)) : null,
    s.info.parking ? h('div', { class: 'info' }, h('h4', null, 'Where cars are parked'), h('p', null, s.info.parking)) : null,
    h('p', { class: 'muted small' }, `Times shown in Swedish time. Last checked ${fmtTime(now)}.`),
  );
}
