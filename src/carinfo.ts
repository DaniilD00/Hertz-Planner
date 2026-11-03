import type { CarKind, Tag } from './types';

export interface CarInfo {
  modelLabel: string;
  kind: CarKind;
  transmission: 'Automatic' | 'Manual' | null;
  awd: boolean;
  tags: Tag[];
  notes: string[];
}

const EV = /\bBEV\b|\bELECTRI|\d\s?KWH\b|\bEL-?BIL\b|\bELBIL\b|POLESTAR|XPENG|TESLA|\bEX\s?(30|40|90)\b|\bEC40\b|\bID\.?\s?[3457]\b|ENYAQ|IONIQ\s?[56]|\bEV[3569]\b|\bMG\s?4\b|E-TRON|\bEQ[ABCES]\b|\bBYD\b|\bZOE\b|\bLEAF\b|BZ4X|\bE-?(208|2008|C4)\b/;
const PLUGIN = /LADDHYBRID|\bPHEV\b|PLUG-?IN|RECHARGE|RECH\b|\bHYB\b/;
const HYBRID = /HYBRID|\bHEV\b/;
const FUEL = /TSI\b|TDI\b|TDCI\b|HDI\b|BLUEHDI\b|TCE\d*\b|DCI\b|\bB[345]\b|BENSIN|\bBEN\b|DIESEL|\bEB\b|ECOBOOST|\bT[2-5]\b|\bD[2-5]\b|\b\d,\d|GDI\b|CRDI\b|\bMHEV\b|TGI\b/;
const VAN = /KANGOO|TRANSIT\b|VIVARO|TRAFIC|SPRINTER|CRAFTER|TRANSPORTER|PROACE|\bVITO\b|\bVARE\b|\bEXPERT\b|BERLINGO|CADDY|\bPARTNER\b|\b\d+(,\d)?\s?M3\b|SKÅP/;
const SUMMER = /SOMMARD[ÄA]CK|SOMMERDEKK|SUMMER\s?TYRE/;
const SEATS = /\b(\d)\s?-?\s?SEATS?\b|\b(\d)\s?PAX\b|\b(\d)-?SITS/;
const WINTER = /VINTERD[ÄA]CK|VINTERDEKK|WINTER\s?TYRE|DUBBD[ÄA]CK|PIGGDEKK/;

const BRANDS: Record<string, string> = {
  VW: 'VW',
  'LYNK&CO': 'Lynk & Co',
  MG: 'MG',
  BMW: 'BMW',
  KIA: 'Kia',
  XPENG: 'XPeng',
  BYD: 'BYD',
};

// Car size classes used by Swedish sites, in English
const CAR_TYPES: Record<string, string> = {
  kombi: 'Estate',
  halvkombi: 'Hatchback',
  sedan: 'Saloon',
  suv: 'SUV',
  'lätt lastbil': 'Light van',
  skåpbil: 'Van',
  minibuss: 'Minibus',
  pickup: 'Pickup',
};

export function carTypeLabel(carType: string | null | undefined): string | null {
  const t = (carType || '').trim();
  if (!t || /^personbil$/i.test(t)) return null;
  return CAR_TYPES[t.toLowerCase()] ?? t;
}

/**
 * Reads what kind of car it is from the model text and the provider's notes, e.g. "VOLVO XC40 B3 FWD AUT"
 * → petrol/diesel, automatic. A gearbox or car size the provider states outright wins over guessing.
 */
export function describeCar(
  model: string,
  notesIn: (string | null | undefined)[] = [],
  stated: { transmission?: 'Automatic' | 'Manual' | null; carType?: string | null } = {},
): CarInfo {
  const raw = (model || '').trim();
  const notes = notesIn
    .map((s) => (s || '').replace(/[*'´`]+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    // drop empty notes and notes that only repeat the model name
    .filter((s) => s.length > 0 && !raw.toUpperCase().includes(s.toUpperCase()));
  const typeLabel = carTypeLabel(stated.carType);
  const text = `${raw} ${notes.join(' ')} ${stated.carType || ''}`.toUpperCase();
  const generic = raw === '' || /^PERSONBIL$/i.test(raw);

  let kind: CarKind = 'unknown';
  if (EV.test(text)) kind = 'electric';
  else if (PLUGIN.test(text) || (/^VOLVO\b/.test(text) && /\bT[68]\b/.test(text))) kind = 'plugin';
  else if (HYBRID.test(text)) kind = 'hybrid';
  else if (FUEL.test(text)) kind = 'fuel';

  const transmission =
    stated.transmission ?? (/\bAUT\b|\bAUTOMAT\b|\bAUTOMATIC\b/.test(text) ? 'Automatic' : /\bMAN\b|\bMANUELL\b/.test(text) ? 'Manual' : null);
  const awd = /\bAWD\b|\b4X4\b|\b4WD\b|4MOTION|QUATTRO|XDRIVE/.test(text);

  const tags: Tag[] = [];
  if (SUMMER.test(text)) tags.push({ label: 'Summer tyres', tone: 'warn' });
  if (WINTER.test(text)) tags.push({ label: 'Winter tyres', tone: 'plain' });
  if (typeLabel) tags.push({ label: typeLabel, tone: 'plain' });
  else if (VAN.test(text)) tags.push({ label: 'Van', tone: 'plain' });
  const seats = SEATS.exec(text);
  if (seats) tags.push({ label: `${seats[1] || seats[2] || seats[3]} seats`, tone: 'plain' });

  return {
    modelLabel: generic ? 'Car model not specified' : prettyModel(raw),
    kind,
    transmission,
    awd,
    tags,
    notes,
  };
}

/** "VOLVO XC40 B3 FWD AUT PLUS DAR" → "Volvo XC40 B3 FWD AUT PLUS DAR" (only the brand is re-cased). */
export function prettyModel(model: string): string {
  const [brand, ...rest] = model.trim().split(/\s+/);
  if (!brand) return model;
  const upper = brand.toUpperCase();
  const pretty = BRANDS[upper] ?? (upper.length <= 2 ? upper : upper.charAt(0) + upper.slice(1).toLowerCase());
  return [pretty, ...rest].join(' ');
}

export const KIND_LABEL: Record<CarKind, string> = {
  electric: 'Electric',
  plugin: 'Plug-in hybrid',
  hybrid: 'Hybrid',
  fuel: 'Petrol / diesel',
  unknown: 'Type not stated',
};
