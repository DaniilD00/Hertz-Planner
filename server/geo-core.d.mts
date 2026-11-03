// Types for server/geo-core.mjs, which the browser imports in the GitHub Pages version.
export interface FoundPlace {
  label: string;
  detail: string;
  lat: number;
  lon: number;
  kind: string;
  city: string | null;
}
export type LonLat = [number, number] | number[];

export const PHOTON_URL: string;
export const NOMINATIM_URL: string;
export const ROUTER_URLS: string[];
export const SEARCH_BBOX: number[];
export const PLAN_TOLERANCE: number;

export function geoKey(a: { lat: number; lon: number }, b: { lat: number; lon: number }): string;
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number;

export function photonSearchUrl(q: string, base?: string): string;
export function parsePhoton(json: unknown): FoundPlace[];
export function nominatimSearchUrl(q: string, base?: string): string;
export function parseNominatim(json: unknown): FoundPlace[];
export function dedupePlaces(list: FoundPlace[]): FoundPlace[];

export function osrmRouteUrl(base: string, from: LonLat, to: LonLat): string;
export function parseOsrm(json: unknown): { coordinates: number[][]; km: number; min: number };
export function planEntry(from: LonLat, to: LonLat, route: { coordinates: number[][]; km: number; min: number }): { p: string; km: number; min: number };

export function encodePolyline(points: number[][]): string;
export function simplify(points: number[][], tolerance: number): number[][];
