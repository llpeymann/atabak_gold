/**
 * Phase 10 — report windows (§4.2).
 *
 * Every business period in this project is a **Tehran calendar day** boundary, and every stored
 * timestamp stays a UTC ISO instant (the project's existing convention). This module is the single
 * place where the two meet, so no screen has to do date arithmetic and no screen can invent a
 * different “start of day”.
 *
 * Contract (identical for every metric in the dashboard):
 *
 *  * `from` is **inclusive**, `to` is **exclusive** — `[from, to)`.
 *  * `today` = the current Tehran day, `7d` / `30d` = the last 7 / 30 Tehran days *including* today,
 *    `all` = from the beginning of recorded data (epoch), custom = the selected Tehran days.
 *  * A window is always bounded: `ADMIN_REPORT_MAX_DAYS` caps a custom range so an operator cannot
 *    ask a question that would scan an unbounded amount of history.
 */

import { tehranDayKey } from '../common/tehran-time';
import { tehranWallClockToIso } from '../bot/content/content-admin.service';
import { ReportPeriodPreset, ReportWindow } from './admin.types';

export const PERIOD_LABELS_FA: Readonly<Record<ReportPeriodPreset, string>> = {
  today: 'امروز',
  '7d': '۷ روز اخیر',
  '30d': '۳۰ روز اخیر',
  all: 'از ابتدا',
  custom: 'بازهٔ سفارشی',
};

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` → the same day shifted by `days` (pure calendar arithmetic, no timezone math). */
export function shiftDayKey(dayKey: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dayKey);

  if (!match) {
    throw new Error(`Invalid Tehran day key: ${dayKey}`);
  }

  const [, year, month, day] = match;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const shifted = new Date(base + days * MS_PER_DAY);

  return shifted.toISOString().slice(0, 10);
}

/** Start of a Tehran day as a UTC instant (the project's single conversion helper). */
export function startOfTehranDay(dayKey: string): string {
  const iso = tehranWallClockToIso(`${dayKey} 00:00`);

  if (iso === null) {
    throw new Error(`Invalid Tehran day key: ${dayKey}`);
  }

  return iso;
}

/** Difference in whole days between two day keys (positive when `to` is later). */
export function daysBetween(fromDayKey: string, toDayKey: string): number {
  const from = Date.parse(startOfTehranDay(fromDayKey));
  const to = Date.parse(startOfTehranDay(toDayKey));

  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * Resolve a preset (or a validated custom range) into a concrete, documented window.
 *
 * The custom case is validated *here*: a malformed day key, a reversed range or a range wider than
 * the configured maximum is refused instead of being silently clamped — an operator must know that
 * the number they are looking at answers a different question than the one they asked.
 */
export function resolveWindow(
  preset: ReportPeriodPreset,
  now: Date,
  options: {
    maxDays: number;
    fromDayKey?: string | null;
    toDayKey?: string | null;
  },
): { ok: true; window: ReportWindow } | { ok: false; message: string } {
  const todayKey = tehranDayKey(now);
  const todayStart = startOfTehranDay(todayKey);

  const build = (
    fromDay: string,
    toDay: string,
    resolvedPreset: ReportPeriodPreset,
  ): ReportWindow => ({
    preset: resolvedPreset,
    from: startOfTehranDay(fromDay),
    // Exclusive upper bound: the start of the day *after* the last selected day.
    to: startOfTehranDay(shiftDayKey(toDay, 1)),
    labelFa: PERIOD_LABELS_FA[resolvedPreset],
    fromDayKey: fromDay,
    toDayKey: toDay,
  });

  switch (preset) {
    case 'today':
      return { ok: true, window: build(todayKey, todayKey, 'today') };
    case '7d':
      return {
        ok: true,
        window: build(shiftDayKey(todayKey, -6), todayKey, '7d'),
      };
    case '30d':
      return {
        ok: true,
        window: build(shiftDayKey(todayKey, -29), todayKey, '30d'),
      };
    case 'all': {
      // `all` means “everything this deployment recorded”. The window starts before any plausible
      // record, so an all-time total can never silently exclude the oldest rows.
      return {
        ok: true,
        window: {
          preset: 'all',
          from: '1970-01-01T00:00:00.000Z',
          to:
            todayStart === ''
              ? now.toISOString()
              : build(todayKey, todayKey, 'today').to,
          labelFa: PERIOD_LABELS_FA.all,
          fromDayKey: '1970-01-01',
          toDayKey: todayKey,
        },
      };
    }
    case 'custom':
    default: {
      const fromDay = (options.fromDayKey ?? '').trim();
      const toDay = (options.toDayKey ?? '').trim();

      if (
        !/^\d{4}-\d{2}-\d{2}$/u.test(fromDay) ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(toDay)
      ) {
        return {
          ok: false,
          message: 'تاریخ باید به شکل YYYY-MM-DD و به وقت تهران باشد.',
        };
      }

      const span = daysBetween(fromDay, toDay);

      if (span < 0) {
        return {
          ok: false,
          message: 'تاریخ شروع باید پیش از تاریخ پایان باشد.',
        };
      }

      if (span + 1 > options.maxDays) {
        return {
          ok: false,
          message: `بازهٔ انتخابی بیش از حد بزرگ است (حداکثر ${options.maxDays} روز).`,
        };
      }

      return { ok: true, window: build(fromDay, toDay, 'custom') };
    }
  }
}

/** `true` when the ISO instant falls inside the window (`[from, to)`). */
export function withinWindow(
  window: ReportWindow,
  iso: string | null | undefined,
): boolean {
  if (typeof iso !== 'string') {
    return false;
  }

  const at = Date.parse(iso);

  if (!Number.isFinite(at)) {
    return false;
  }

  return at >= Date.parse(window.from) && at < Date.parse(window.to);
}

/** Does the Tehran day key fall inside the window? (used for the day-set activity metric) */
export function dayWithinWindow(window: ReportWindow, dayKey: string): boolean {
  return dayKey >= window.fromDayKey && dayKey <= window.toDayKey;
}
