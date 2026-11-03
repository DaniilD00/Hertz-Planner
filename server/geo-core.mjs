// Place search and routing helpers with no Node dependencies, shared by the local server (server/geo.mjs) and the
// browser (the GitHub Pages version has no server, so it asks Photon, Nominatim and OSRM directly; all three allow it).

export const PHOTON_URL = 'https://photon.komoot.io';
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
// Fastest-route servers (same OSRM API). The first that answers wins; the rest are fallbacks.
export const ROUTER_URLS = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];
export const SEARCH_BBOX = [4, 54.5, 32, 71.5]; // Norway, Sweden, Denmark, Finland
export const PLAN_TOLERANCE = 0.0005; // ~50 m is plenty for measuring distance to a planned route

/** Key for a road shape between two points, shared by server and browser. Never contains a comma. */
export function geoKey(a, b) {
  return `${a.lat.toFixed(4)}/${a.lon.toFixed(4)}>${b.lat.toFixed(4)}/${b.lon.toFixed(4)}`;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const x = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742.0176 * Math.asin(Math.min(1, Math.sqrt(x)));
}

// ---------- place search ----------

export const photonSearchUrl = (q, base = PHOTON_URL) => `${base}/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&bbox=${SEARCH_BBOX.join(',')}`;

export function parsePhoton(json) {
  const out = [];
  for (const f of json?.features || []) {
    const pr = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    const label = pr.name || [pr.street, pr.housenumber].filter(Boolean).join(' ');
    if (!Number.isFinite(lat) || !label) continue;
    const city = pr.city || pr.locality || (pr.osm_key === 'place' ? pr.name : null) || null;
    const area = [city !== label ? city : null, pr.county || pr.state, pr.country].filter(Boolean);
    out.push({ label, detail: [...new Set(area)].join(', '), lat, lon, kind: pr.osm_value || pr.type || '', city });
  }
  return dedupePlaces(out);
}

export const nominatimSearchUrl = (q, base = NOMINATIM_URL) =>
  `${base}/search?format=jsonv2&limit=6&addressdetails=1&countrycodes=se,no,dk,fi&q=${encodeURIComponent(q)}`;

export function parseNominatim(json) {
  return dedupePlaces(
    (Array.isArray(json) ? json : []).map((r) => {
      const parts = String(r.display_name || '').split(',').map((x) => x.trim());
      const a = r.address || {};
      return {
        label: r.name || parts[0],
        detail: parts.slice(1, 4).join(', '),
        lat: Number(r.lat),
        lon: Number(r.lon),
        kind: r.type || '',
        city: a.city || a.town || a.village || a.municipality || null,
      };
    }),
  );
}

export function dedupePlaces(list) {
  const out = [];
  for (const p of list) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (out.some((o) => o.label === p.label && Math.abs(o.lat - p.lat) < 0.05 && Math.abs(o.lon - p.lon) < 0.05)) continue;
    out.push(p);
  }
  return out.slice(0, 5);
}

// ---------- routing ----------

export const osrmRouteUrl = (base, from, to) => `${base}/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`;

/** OSRM answer → { coordinates, km, min }, or throws. */
export function parseOsrm(json) {
  const route = json?.routes?.[0];
  if (json?.code !== 'Ok' || !route?.geometry?.coordinates?.length) throw new Error(json?.message || json?.code || 'no route');
  return { coordinates: route.geometry.coordinates, km: Math.round(route.distance / 1000), min: Math.round(route.duration / 60) };
}

/** A planned road (your start → your destination) as the page uses it: simplified, encoded, with km and minutes. */
export function planEntry(from, to, route) {
  return { p: encodePolyline(simplify([from, ...route.coordinates, to], PLAN_TOLERANCE)), km: route.km, min: route.min };
}

// ---------- line helpers ----------

/** Google "encoded polyline" (precision 5) of [lon, lat] pairs: about 5 bytes per point instead of ~20 in JSON. */
export function encodePolyline(points) {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [lon, lat] of points) {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    out += encodeValue(la - prevLat) + encodeValue(lo - prevLon);
    prevLat = la;
    prevLon = lo;
  }
  return out;
}

function encodeValue(v) {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let s = '';
  while (n >= 0x20) {
    s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>= 5;
  }
  return s + String.fromCharCode(n + 63);
}

// Ramer–Douglas–Peucker on [lon, lat] pairs (iterative, so long routes don't blow the stack).
export function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist2(points[i], points[first], points[last]);
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (index !== -1 && maxD > tol2) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function segDist2(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}
