// Hertz Freerider: public JSON with exact station coordinates. Times are UTC without a "Z".

import { fetchJson, hhmmStockholm, utcFromNaive } from '../util.mjs';

const BASE = (process.env.HERTZ_URL || 'https://www.hertzfreerider.se').replace(/\/$/, '');
const SITE = 'https://www.hertzfreerider.se/sv-se/';

export const hertz = {
  id: 'hertz',
  name: 'Hertz Freerider',
  site: SITE,
  async fetch() {
    const groups = await fetchJson(`${BASE}/api/transport-routes/`, { label: 'hertzfreerider.se' });
    if (!Array.isArray(groups)) throw new Error('hertzfreerider.se sent an unexpected response');
    return parseHertz(groups);
  },
};

const num = (v) => (Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Raw Hertz groups → common stations and offers. Pure, so it can be tested. */
export function parseHertz(groups) {
  const stations = {};
  const offers = [];
  const seen = new Set();
  const station = (l) => {
    const id = `hertz:${l.tracCode}`;
    if (!stations[id]) {
      const hours = [];
      for (let d = 1; d <= 7; d++) {
        const h = l.regularOpeningHours?.[String(d)];
        hours.push(h?.openingTime && h?.closingTime ? [hhmmStockholm(h.openingTime), hhmmStockholm(h.closingTime)] : null);
      }
      stations[id] = {
        id,
        provider: 'hertz',
        legacy: l.tracCode, // key used for saved road shapes before several providers were supported
        name: l.name,
        city: l.city || '',
        country: (l.country || 'se').toLowerCase(),
        address: (l.address || '').trim(),
        phone: (l.phoneNumber || '').trim(),
        lat: l.geoLat,
        lon: l.geoLon,
        precision: 'exact',
        kiosk: !!l.kiosk,
        hours,
        info: {
          location: text(l.infoTextLocationEnglish) ?? text(l.infoTextLocationNative),
          parking: text(l.infoTextParkingEnglish) ?? text(l.infoTextParkingNative),
          return: text(l.infoTextReturnEnglish) ?? text(l.infoTextReturnNative),
          dropOff: text(l.infoTextDropOffEnglish) ?? text(l.infoTextDropOffNative),
          misc: text(l.infoTextMiscEnglish) ?? text(l.infoTextMiscNative),
        },
      };
    }
    return stations[id];
  };

  for (const g of groups) {
    for (const r of g?.routes || []) {
      const a = r?.pickupLocation;
      const b = r?.returnLocation;
      if (!a?.tracCode || !b?.tracCode || seen.has(r.id)) continue;
      if (!Number.isFinite(a.geoLat) || !Number.isFinite(a.geoLon) || !Number.isFinite(b.geoLat) || !Number.isFinite(b.geoLon)) continue;
      const availableFrom = utcFromNaive(r.availableAt);
      const offerExpires = utcFromNaive(r.expireTime);
      if (!availableFrom || !offerExpires) continue;
      seen.add(r.id);
      offers.push({
        provider: 'hertz',
        id: `hertz:${r.id}`,
        offerId: `hertz:${r.transportOfferId}`,
        from: station(a).id,
        to: station(b).id,
        availableFrom,
        offerExpires,
        returnBy: utcFromNaive(r.latestReturn),
        maxKm: num(r.distance),
        estKm: Number.isFinite(r.originalDistance) ? Math.round(r.originalDistance) : null,
        maxMin: num(r.travelTime),
        estMin: num(r.originalTravelTime),
        model: r.carModel || '',
        carType: null,
        transmission: null,
        notes: [r.publicDescription, r.publicInformation].filter((s) => typeof s === 'string' && s.trim()),
        terms: [],
        bookUrl: SITE,
      });
    }
  }
  return { stations, offers, unplaced: 0 };
}
