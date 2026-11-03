// DriveBack: /resor answers with JSON when asked for it. Each trip can go to several destinations (one car, pick one).
// Their coordinates are town centres, so the street address is looked up for a precise position (kept only if it
// lands near the town they give). Times are Swedish wall-clock time stored with a "Z" — their own site shows
// "…T13:00:00.000Z" as 13:00 — so they're read as Swedish time.

import { fetchJson, tidyCase, wallTimeAsStockholm } from '../util.mjs';

const BASE = (process.env.DRIVEBACK_URL || 'https://www.driveback.se').replace(/\/$/, '');

export const driveback = {
  id: 'driveback',
  name: 'DriveBack',
  site: 'https://www.driveback.se/resor',
  async fetch(ctx) {
    const trips = await fetchJson(`${BASE}/resor`, { label: 'driveback.se' });
    if (!Array.isArray(trips)) throw new Error('driveback.se sent an unexpected response');
    return parseDriveBack(trips, ctx.locateAddress);
  },
};

// "10 500 kr" with a non-breaking space, so the number never wraps (same on every machine, unlike toLocaleString)
const kr = (n) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0kr`;

/** Raw DriveBack trips → common stations and offers. `locate` finds an address on the map. */
export async function parseDriveBack(trips, locate) {
  const stations = {};
  const offers = [];
  let unplaced = 0;

  const place = async (s) => {
    if (!s || s.id == null) return null;
    const id = `driveback:${s.id}`;
    if (stations[id]) return stations[id];
    const street = tidyCase([s.address1, s.address2].filter((x) => x && String(x).trim()).join(', '));
    const town = tidyCase(s.area || s.location?.city || '');
    const zipTown = [String(s.zip || '').trim(), town].filter(Boolean).join(' ');
    const text = [street, zipTown].filter(Boolean).join(', ');
    const near = Number.isFinite(s.location?.latitude) && Number.isFinite(s.location?.longitude) ? { lat: s.location.latitude, lon: s.location.longitude } : null;
    const loc = await locate({ text, town: town || null, near, maxKm: 80 });
    if (!loc) return null;
    stations[id] = {
      id,
      provider: 'driveback',
      name: text,
      place: town || tidyCase(s.location?.city || '') || street,
      city: tidyCase(s.location?.city || town),
      country: 'se',
      address: text,
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
    if (!t?.id || !Array.isArray(t.to_stations)) continue;
    const availableFrom = wallTimeAsStockholm(t.first_pickup);
    const offerExpires = wallTimeAsStockholm(t.last_deliver);
    if (!availableFrom || !offerExpires) continue;
    const from = await place(t.from_station);
    if (!from) {
      unplaced += t.to_stations.length;
      continue;
    }
    const v = t.vehicle || {};
    const terms = [];
    if (t.license_req) {
      const years = Number(t.minimum_license_years) || 0;
      terms.push({ label: 'Licence', value: `${t.license_req}${years ? `, held at least ${years} ${years === 1 ? 'year' : 'years'}` : ''}` });
    }
    if (Number.isFinite(t.min_age)) terms.push({ label: 'Minimum age', value: String(t.min_age) });
    if (Number.isFinite(t.deductible)) terms.push({ label: 'Deductible', value: kr(t.deductible) });
    if (Number.isFinite(t.deposition)) terms.push({ label: 'Deposit', value: kr(t.deposition) });
    for (const st of t.to_stations) {
      const to = await place(st);
      if (!to) {
        unplaced++;
        continue;
      }
      offers.push({
        provider: 'driveback',
        id: `driveback:${t.id}>${st.id}`,
        offerId: `driveback:${t.id}`,
        from: from.id,
        to: to.id,
        availableFrom,
        offerExpires,
        returnBy: null,
        maxKm: null,
        estKm: null,
        maxMin: null,
        estMin: null,
        model: (v.car_model || '').trim(),
        carType: v.car_size || null,
        transmission: v.gearbox === false ? 'Automatic' : v.gearbox === true ? 'Manual' : null,
        notes: [],
        terms,
        bookUrl: `${BASE}/resor/${t.id}/boka/${st.id}`,
      });
    }
  }
  return { stations, offers, unplaced };
}
