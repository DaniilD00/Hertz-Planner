// Drive4Free: public JSON (the feed behind their "available trips" widget). Pickup and drop-off are free-text
// addresses without coordinates, so each one is looked up on the map once and saved.

import { endOfStockholmDay, fetchJson, slug } from '../util.mjs';

const BASE = (process.env.DRIVE4FREE_URL || 'https://api.drive4free.io').replace(/\/$/, '');
const BOOK = 'https://app.drive4free.io/login';

export const drive4free = {
  id: 'drive4free',
  name: 'Drive4Free',
  site: 'https://drive4free.io/',
  async fetch(ctx) {
    const trips = await fetchJson(`${BASE}/api/v1/trips/public`, { label: 'drive4free.io' });
    if (!Array.isArray(trips)) throw new Error('drive4free.io sent an unexpected response');
    return parseDrive4Free(trips, ctx.locateAddress);
  },
};

/**
 * Best guess at the town in a free-text address:
 * "Prästvägen 105, 44293 Kareby," → "Kareby", "Knuts väg 14 Skepplanda 446 41 Göteborg" → "Göteborg".
 */
export function townFromAddress(text) {
  const s = String(text || '')
    .replace(/\b\d{3}\s?\d{2}\b/g, ' ') // postcodes
    .replace(/[,;]+/g, ' ');
  const words = s.split(/\s+/).filter((w) => /^\p{L}[\p{L}-]*$/u.test(w));
  for (let i = words.length - 1; i >= 0; i--) if (/^\p{Lu}/u.test(words[i])) return words[i];
  return words[words.length - 1] ?? null;
}

/** Raw Drive4Free trips → common stations and offers. `locate` finds an address on the map. */
export async function parseDrive4Free(trips, locate) {
  const stations = {};
  const offers = [];
  let unplaced = 0;

  const place = async (raw) => {
    const clean = String(raw || '').trim().replace(/[\s,]+$/, '');
    if (!clean) return null;
    const id = `drive4free:${slug(clean)}`;
    if (stations[id]) return stations[id];
    const town = townFromAddress(clean);
    const loc = await locate({ text: clean, town: town && town !== clean ? town : null });
    if (!loc) return null;
    stations[id] = {
      id,
      provider: 'drive4free',
      name: clean,
      place: town || loc.city || clean,
      city: loc.city || town || '',
      country: 'se',
      address: clean,
      lat: loc.lat,
      lon: loc.lon,
      precision: loc.precision,
      kiosk: false,
      hours: null,
      info: {},
    };
    return stations[id];
  };

  for (const t of trips) {
    if (!t?.id || !t.pickup_time) continue;
    const start = new Date(t.pickup_time);
    if (Number.isNaN(start.getTime())) continue;
    const from = await place(t.pickup_location);
    const to = await place(t.dropoff_location);
    if (!from || !to) {
      unplaced++;
      continue;
    }
    const end = t.pickup_time_end ? new Date(t.pickup_time_end) : null;
    offers.push({
      provider: 'drive4free',
      id: `drive4free:${t.id}`,
      offerId: `drive4free:${t.id}`,
      from: from.id,
      to: to.id,
      availableFrom: start.toISOString(),
      offerExpires: end && !Number.isNaN(end.getTime()) ? end.toISOString() : endOfStockholmDay(start.toISOString()),
      returnBy: null,
      maxKm: null,
      estKm: null,
      maxMin: null,
      estMin: null,
      model: (t.vehicle_info || '').trim(),
      carType: null,
      transmission: t.transmission_type === 'automatic' ? 'Automatic' : t.transmission_type === 'manual' ? 'Manual' : null,
      notes: [],
      terms: [],
      bookUrl: BOOK,
    });
  }
  return { stations, offers, unplaced };
}
