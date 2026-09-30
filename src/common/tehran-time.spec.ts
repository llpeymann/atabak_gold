import { tehranDateFa, tehranDayKey, tehranTimeFa } from './tehran-time';

describe('Tehran time helpers', () => {
  it('derives the day key in Tehran time, not UTC', () => {
    // 2026-09-29 21:30 UTC === 2026-09-30 01:00 in Tehran (+03:30)
    expect(tehranDayKey(new Date('2026-09-29T21:30:00Z'))).toBe('2026-09-30');
  });

  it('keeps a late Tehran evening inside the same day', () => {
    // 2026-09-30 20:29 UTC === 2026-09-30 23:59 in Tehran
    expect(tehranDayKey(new Date('2026-09-30T20:29:00Z'))).toBe('2026-09-30');
  });

  it('renders Persian date and time with Persian digits', () => {
    const date = new Date('2026-09-30T09:00:00Z'); // 12:30 in Tehran

    expect(tehranTimeFa(date)).toMatch(/[۰-۹]{2}:[۰-۹]{2}/);
    expect(tehranDateFa(date)).toMatch(/[۰-۹]{4}/);
  });
});
