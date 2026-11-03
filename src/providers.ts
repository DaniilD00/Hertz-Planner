import type { ProviderId } from './types';

// Every site gets its own colour family. Hue tells you who offers the trip; line style (solid / dashed / dotted)
// tells you when it's available, so the two never compete.
//   Hertz Freerider  amber → yellow  (sodium-lamp amber, as before)
//   DriveBack        violet          (a step away from their blue, so it can't be mistaken for Drive4Free's teal)
//   Drive4Free       teal            (from their logo)

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  short: string;
  site: string;
  siteLabel: string;
  colors: {
    now: string; // available now: solid line with glow
    soon: string; // opens within a day: dashed, lighter
    later: string; // opens later: dotted, deeper and faint
    ink: string; // text on a `now` background
  };
  /**
   * Shades within the site's colour family. Routes that overlap on the map get different shades, so you can tell
   * them apart (the first is the site's main colour). Lighter "soon" and deeper "later" versions are mixed from these.
   */
  shades: string[];
  /** What the provider calls the end of the pickup window */
  expiresLabel: string;
  bookLabel: string;
  bookNote: string;
  /** Things that hold for all of this provider's trips (shown in the trip panel) */
  notes: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  hertz: {
    id: 'hertz',
    name: 'Hertz Freerider',
    short: 'Hertz',
    site: 'https://www.hertzfreerider.se/sv-se/',
    siteLabel: 'hertzfreerider.se',
    colors: { now: '#ffb547', soon: '#ffd47e', later: '#c9994f', ink: '#1d1408' },
    // close neighbours of the amber, so the map still reads as one colour: amber, soft orange, golden, deep amber
    shades: ['#ffb547', '#ff9d45', '#ffca5e', '#eea23f'],
    expiresLabel: 'Offer expires',
    bookLabel: 'Book on hertzfreerider.se',
    bookNote: 'You book on the Hertz site and need to log in there.',
    notes: [],
  },
  driveback: {
    id: 'driveback',
    name: 'DriveBack',
    short: 'DriveBack',
    site: 'https://www.driveback.se/resor',
    siteLabel: 'driveback.se',
    colors: { now: '#a48dff', soon: '#c7baff', later: '#7a6bc6', ink: '#150e33' },
    shades: ['#a48dff', '#b495ff', '#9690ff'],
    expiresLabel: 'Pick up by',
    bookLabel: 'Book this trip on driveback.se',
    bookNote: 'The button opens this exact trip. Booking needs a DriveBack account.',
    notes: ['Fuel is included (up to one tank).'],
  },
  drive4free: {
    id: 'drive4free',
    name: 'Drive4Free',
    short: 'Drive4Free',
    site: 'https://drive4free.io/',
    siteLabel: 'drive4free.io',
    colors: { now: '#35d0ba', soon: '#8be7d9', later: '#3a9c8e', ink: '#06261f' },
    shades: ['#35d0ba', '#46d7a9', '#34c5ca'],
    expiresLabel: 'Pick-up window ends',
    bookLabel: 'Register interest on drive4free.io',
    bookNote: 'Drive4Free matches drivers to trips. You register interest with a Drive4Free account.',
    notes: ['Fuel and insurance are included.'],
  },
};

export const PROVIDER_ORDER: ProviderId[] = ['hertz', 'driveback', 'drive4free'];

export const isProvider = (v: unknown): v is ProviderId => typeof v === 'string' && v in PROVIDERS;
