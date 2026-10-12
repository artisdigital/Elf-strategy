// Timezone helpers. All session logic uses America/New_York via the platform's IANA
// timezone database (Intl), so daylight-saving transitions are handled automatically.

export const NY_TZ = 'America/New_York';

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
  /** Minutes since local midnight. */
  minuteOfDay: number;
  /** YYYY-MM-DD local date. */
  dateKey: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Cache by (tz, UTC minute) — candles repeat the same timestamps heavily during replays/backtests.
const partsCache = new Map<string, ZonedParts>();

/** Local calendar parts of a UTC-seconds timestamp in the given IANA timezone. */
export function zonedParts(utcSeconds: number, tz: string = NY_TZ): ZonedParts {
  const minuteKey = Math.floor(utcSeconds / 60);
  const cacheKey = tz + '|' + minuteKey;
  const cached = partsCache.get(cacheKey);
  if (cached) return cached;
  const parts = formatter(tz).formatToParts(new Date(minuteKey * 60_000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const result: ZonedParts = {
    year,
    month,
    day,
    hour,
    minute,
    weekday: WEEKDAYS[get('weekday')] ?? 0,
    minuteOfDay: hour * 60 + minute,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
  if (partsCache.size > 200_000) partsCache.clear();
  partsCache.set(cacheKey, result);
  return result;
}

/** Parse "HH:MM" into minutes since midnight. Throws on invalid input. */
export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`Invalid time "${value}" (expected HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time "${value}"`);
  return h * 60 + min;
}

/** Shift a YYYY-MM-DD key by whole days (calendar arithmetic, timezone independent). */
export function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Convert a local wall-clock time in `tz` to UTC seconds.
 * Uses iterative correction against the tz offset (works across DST transitions; for a
 * non-existent local time in the spring-forward gap it resolves to the later valid instant).
 */
export function zonedTimeToUtc(dateKey: string, minuteOfDay: number, tz: string = NY_TZ): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const targetLocalMs = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let guess = targetLocalMs;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(Math.floor(guess / 1000), tz);
    const localMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = targetLocalMs - localMs;
    if (diff === 0) break;
    guess += diff;
  }
  return Math.floor(guess / 1000);
}

export function formatNy(utcSeconds: number, withDate = true): string {
  const p = zonedParts(utcSeconds);
  const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  return withDate ? `${p.dateKey} ${hm} ET` : `${hm} ET`;
}
