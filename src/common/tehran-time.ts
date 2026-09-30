/**
 * Tehran time helpers — single source of truth for timezone-dependent values.
 * The application targets Iranian market hours, so every schedule and every rendered
 * date/time is derived from `Asia/Tehran`, independent of the container's own TZ.
 */

export const TEHRAN_TIME_ZONE = 'Asia/Tehran';

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TEHRAN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dateFormatterFa = new Intl.DateTimeFormat('fa-IR', {
  timeZone: TEHRAN_TIME_ZONE,
});

const timeFormatterFa = new Intl.DateTimeFormat('fa-IR', {
  timeZone: TEHRAN_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Stable calendar key of the Tehran trading day, e.g. `2026-09-30`.
 * Used to reset day-scoped state (trend comparison) exactly once per day.
 */
export function tehranDayKey(date: Date): string {
  return dayKeyFormatter.format(date);
}

/** Persian date for display, e.g. `۱۴۰۵/۰۷/۰۸`. */
export function tehranDateFa(date: Date): string {
  return dateFormatterFa.format(date);
}

/** Persian time for display, e.g. `۱۲:۳۰`. */
export function tehranTimeFa(date: Date): string {
  return timeFormatterFa.format(date);
}
