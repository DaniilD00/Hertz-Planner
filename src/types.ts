export type ProviderId = 'hertz' | 'driveback' | 'drive4free';

// ---- What the local server sends (GET /api/routes): one common format for every provider ----

export interface WireStation {
  id: string; // provider-scoped: "hertz:SWJKG61", "driveback:823", "drive4free:halmstad"
  provider: ProviderId;
  legacy?: string;
  name: string; // Hertz: station name. Others: street address.
  place?: string; // town for titles (sent for address-based providers)
  city?: string;
  country?: string;
  address?: string;
  phone?: string;
  lat: number;
  lon: number;
  /** exact = provider's own coordinates; address = looked up from the street address; town = only the town is known */
  precision: 'exact' | 'address' | 'town';
  kiosk?: boolean;
  hours?: ([string, string] | null)[] | null; // "HH:MM" Swedish time, Monday first
  info?: { location?: string; parking?: string; return?: string; dropOff?: string; misc?: string };
}

export interface WireOffer {
  provider: ProviderId;
  id: string;
  offerId: string; // the same car offered to several destinations shares this
  from: string; // station ids
  to: string;
  availableFrom: string; // ISO, UTC
  offerExpires: string;
  returnBy: string | null;
  maxKm: number | null;
  estKm: number | null;
  maxMin: number | null;
  estMin: number | null;
  model: string;
  carType: string | null; // "Kombi", "Lätt lastbil"…
  transmission: 'Automatic' | 'Manual' | null;
  notes: string[];
  terms: Term[];
  bookUrl: string;
}

export interface Term {
  label: string;
  value: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  site: string;
  count: number;
  unplaced: number; // trips that couldn't be put on the map
  fetchedAt: string | null;
  error: string | null;
  stale: boolean; // last refresh failed; showing older trips
  loading: boolean; // first fetch still running
}

export interface RoutesResponse {
  fetchedAt: string;
  snapshotAt?: string; // GitHub Pages version: when the scheduled job published these trips
  providers: ProviderStatus[];
  stations: Record<string, WireStation>;
  offers: WireOffer[];
}

export interface GeometryResponse {
  shapes: Record<string, { p: string; km?: number; min?: number }>; // p = encoded polyline (precision 5)
  saved: number; // road shapes stored on disk
  pending: number; // lookups still queued
  serverTime: number; // pass back as `since` to get only newer shapes
}

// ---- Normalised model used by the UI ----

export type Status = 'now' | 'soon' | 'later';
export type CarKind = 'electric' | 'plugin' | 'hybrid' | 'fuel' | 'unknown';

export interface Tag {
  label: string;
  tone: 'warn' | 'plain';
}

export interface Station {
  code: string; // = WireStation.id
  provider: ProviderId;
  name: string;
  short: string; // name without "/ Self Service Kiosk", or the street part of an address
  place: string; // "Jönköping", "Arlanda Airport": used in titles
  city: string;
  country: string;
  lat: number;
  lon: number;
  address: string;
  phone: string;
  kiosk: boolean;
  precision: 'exact' | 'address' | 'town';
  hours: ([string, string] | null)[] | null; // index 0 = Monday
  info: { location?: string; parking?: string; return?: string; dropOff?: string; misc?: string };
  outCars: number;
  inCars: number;
  hasNow: boolean;
}

export interface CarOffer {
  provider: ProviderId;
  routeId: string;
  offerId: string;
  model: string;
  modelLabel: string;
  kind: CarKind;
  transmission: 'Automatic' | 'Manual' | null;
  awd: boolean;
  carType: string | null;
  tags: Tag[];
  notes: string[];
  terms: Term[];
  bookUrl: string;
  availableFrom: Date;
  offerExpires: Date;
  returnBy: Date | null;
  maxKm: number | null;
  estKm: number | null;
  maxMin: number | null;
  estMin: number | null;
  status: Status;
  alsoOfferedTo: Station[];
}

export interface Corridor {
  id: string; // "hertz:SWJKG61>hertz:SWGOT50"
  provider: ProviderId;
  from: Station;
  to: Station;
  cars: CarOffer[];
  carCount: number;
  status: Status;
  rank: number; // 0 now, 1 soon, 2 later
  earliestFrom: Date;
  soonestExpiry: Date;
  expiresSoon: boolean;
  estKm: number | null;
  estMin: number | null;
  kinds: CarKind[];
  routeIds: string[];
  /** which of the site's shades the line is drawn in (routes that overlap get different ones) */
  shade?: number;
}

export interface Totals {
  cars: number;
  carsNow: number;
  routes: number;
}

export interface Model {
  stations: Map<string, Station>;
  corridors: Corridor[];
  totals: Totals & { stations: number };
  byProvider: Record<ProviderId, Totals>;
}
