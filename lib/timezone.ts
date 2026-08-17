// App-wide timezone pin. MagickUtils customers are overwhelmingly India-based,
// so every calendar day, hour bucket, and clock label is India Standard Time
// (Asia/Kolkata, UTC+05:30, no DST) — never the host process TZ or the
// browser's local zone.

export const APP_TIMEZONE = "Asia/Kolkata" as const;
export const APP_TIMEZONE_LABEL = "IST";
export type AppTimezone = typeof APP_TIMEZONE;

/** IST is UTC+05:30 with no daylight-saving, so a fixed offset is exact. */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export interface AppTimeParts {
  year: number;
  month: number; // 0–11
  date: number;
  weekday: number; // 0=Sun … 6=Sat
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Shift a UTC instant so `getUTC*` returns IST calendar parts. */
function asIst(d: Date): Date {
  return new Date(d.getTime() + IST_OFFSET_MS);
}

/** Build a UTC instant from IST civil parts. `Date.UTC` overflow (day 32, etc.) is intentional. */
export function fromAppTimeParts(
  year: number,
  month: number,
  date: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
  milliseconds = 0,
): Date {
  return new Date(Date.UTC(year, month, date, hours, minutes, seconds, milliseconds) - IST_OFFSET_MS);
}

export function getAppTimeParts(d: Date): AppTimeParts {
  const ist = asIst(d);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth(),
    date: ist.getUTCDate(),
    weekday: ist.getUTCDay(),
    hours: ist.getUTCHours(),
    minutes: ist.getUTCMinutes(),
    seconds: ist.getUTCSeconds(),
    milliseconds: ist.getUTCMilliseconds(),
  };
}

export function startOfAppDay(d: Date): Date {
  const p = getAppTimeParts(d);
  return fromAppTimeParts(p.year, p.month, p.date);
}

export function startOfAppHour(d: Date): Date {
  const p = getAppTimeParts(d);
  return fromAppTimeParts(p.year, p.month, p.date, p.hours);
}

export function startOfAppMinute(d: Date): Date {
  const p = getAppTimeParts(d);
  return fromAppTimeParts(p.year, p.month, p.date, p.hours, p.minutes);
}

export function addAppDays(d: Date, days: number): Date {
  const p = getAppTimeParts(d);
  return fromAppTimeParts(p.year, p.month, p.date + days, p.hours, p.minutes, p.seconds, p.milliseconds);
}

export function sameAppDay(a: Date, b: Date): boolean {
  const pa = getAppTimeParts(a);
  const pb = getAppTimeParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.date === pb.date;
}

/** `YYYY-MM-DD` in IST — the dashboard volume series key. */
export function formatAppYmd(d: Date): string {
  const p = getAppTimeParts(d);
  return `${p.year}-${pad2(p.month + 1)}-${pad2(p.date)}`;
}

/** Parse an IST calendar date (`YYYY-MM-DD`) as midnight IST. */
export function parseAppYmd(ymd: string): Date {
  const [year, month, date] = ymd.split("-").map(Number);
  return fromAppTimeParts(year, month - 1, date);
}

export function formatAppDate(d: Date, opts?: { year?: boolean }): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: opts?.year ? "numeric" : undefined,
    timeZone: APP_TIMEZONE,
  });
}

export function formatAppTime(d: Date, opts?: { minute?: boolean }): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: opts?.minute ? "2-digit" : undefined,
    timeZone: APP_TIMEZONE,
  });
}

export function formatAppDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatAppDate(d, { year: true });
}

export function formatAppClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatAppTime(d, { minute: true });
}
