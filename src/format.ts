// Times come from the local server as ISO UTC; every site shows them in Swedish time, so do we.

export const TZ = 'Europe/Stockholm';

export function parseUtc(value: string | null | undefined): Date {
  if (!value) return new Date(NaN);
  const hasZone = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value);
  return new Date(hasZone ? value : `${value}Z`);
}

const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const weekdayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });

const dayKey = (d: Date) => dayKeyFmt.format(d);

export function fmtTime(d: Date): string {
  return timeFmt.format(d);
}

/** "Today 12:00", "Tomorrow 09:30" or "Thu 22 Oct 19:50" */
export function fmtWhen(d: Date, now: Date = new Date()): string {
  if (Number.isNaN(d.getTime())) return '–';
  const k = dayKey(d);
  if (k === dayKey(now)) return `Today ${fmtTime(d)}`;
  if (k === dayKey(new Date(now.getTime() + 864e5))) return `Tomorrow ${fmtTime(d)}`;
  if (k === dayKey(new Date(now.getTime() - 864e5))) return `Yesterday ${fmtTime(d)}`;
  return `${dateFmt.format(d)} ${fmtTime(d)}`;
}

/** Monday = 0 … Sunday = 6, in Swedish time */
export function weekdayIndex(d: Date = new Date()): number {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return names.indexOf(weekdayFmt.format(d));
}

/** Rough human span: "45 min", "3 h 20 min", "2 d 5 h" */
export function fmtSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const m = min % 60;
    return m && h < 10 ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

export function fmtMinutes(min: number | null | undefined): string {
  if (min == null || Number.isNaN(min)) return '–';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtAgo(d: Date, now: Date = new Date()): string {
  const ms = now.getTime() - d.getTime();
  if (ms < 60000) return 'just now';
  return `${fmtSpan(ms)} ago`;
}

/** Opening hours are "HH:MM" strings in Swedish time (converted by the server the way each site shows them). */
export function fmtHours(h: [string, string] | null | undefined): string {
  if (!h) return 'Closed';
  return `${h[0]}–${h[1]}`;
}

// ---------- Swedish calendar days (for "today", "tomorrow", "this weekend") ----------

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function stockholmParts(ms: number) {
  const p = Object.fromEntries(partsFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** The instant at which Swedish clocks show this wall time (handles summer/winter time). */
export function stockholmWallTime(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const p = stockholmParts(t);
    const next = t - (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - wall);
    if (next === t) break;
    t = next;
  }
  return new Date(t);
}

/** Start of the Swedish calendar day `offset` days after the one containing `d`. */
export function startOfDay(d: Date, offset = 0): Date {
  const p = stockholmParts(d.getTime());
  const base = new Date(Date.UTC(p.y, p.mo - 1, p.d + offset)); // calendar arithmetic in UTC, then back to Sweden
  return stockholmWallTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
