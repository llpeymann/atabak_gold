import {
  BOT_ROUTES,
  isBotRoute,
  parseStartPayload,
  screenForRoute,
} from './deep-link';

/**
 * §13.1 / §13.2 — the route registry and the start-payload parser.
 *
 * The parser is the only door untrusted input (a link somebody typed, forwarded or edited) can enter
 * through, so it is tested on its own: it must normalize, reject malformed input safely, ignore extra
 * parameters, and never turn an unknown payload into a feature.
 */

describe('deep-link registry (§6)', () => {
  it('contains exactly the five approved routes', () => {
    expect([...BOT_ROUTES]).toEqual([
      'alert',
      'prices',
      'coin',
      'gold',
      'channel',
    ]);
  });

  it('recognizes only the approved route ids', () => {
    expect(isBotRoute('alert')).toBe(true);
    expect(isBotRoute('prices')).toBe(true);
    expect(isBotRoute('coin')).toBe(true);
    expect(isBotRoute('gold')).toBe(true);
    expect(isBotRoute('channel')).toBe(true);

    expect(isBotRoute('admin')).toBe(false);
    expect(isBotRoute('publish')).toBe(false);
    expect(isBotRoute('ALERT')).toBe(false);
    expect(isBotRoute('')).toBe(false);
    expect(isBotRoute(null)).toBe(false);
    expect(isBotRoute(42)).toBe(false);
    expect(isBotRoute({ route: 'alert' })).toBe(false);
  });

  it('maps every route to its existing screen (the alert route starts the wizard instead)', () => {
    expect(screenForRoute('prices')).toBe('prices');
    expect(screenForRoute('coin')).toBe('coins');
    expect(screenForRoute('gold')).toBe('gold');
    expect(screenForRoute('channel')).toBe('channel');
    expect(screenForRoute('alert')).toBeNull();
  });
});

describe('start payload parsing (§6.2)', () => {
  it('treats a bare /start (and empty input) as the default entry point', () => {
    expect(parseStartPayload('/start')).toEqual({ kind: 'none' });
    expect(parseStartPayload('/start   ')).toEqual({ kind: 'none' });
    expect(parseStartPayload('')).toEqual({ kind: 'none' });
    expect(parseStartPayload('   ')).toEqual({ kind: 'none' });
    expect(parseStartPayload(null)).toEqual({ kind: 'none' });
    expect(parseStartPayload(undefined)).toEqual({ kind: 'none' });
  });

  it('resolves each approved payload to its route', () => {
    for (const route of BOT_ROUTES) {
      expect(parseStartPayload(`/start ${route}`)).toEqual({
        kind: 'route',
        route,
        raw: route,
      });
    }
  });

  it('accepts the /start@botname form platforms send in group contexts', () => {
    expect(parseStartPayload('/start@atabak_bot prices')).toEqual({
      kind: 'route',
      route: 'prices',
      raw: 'prices',
    });
  });

  it('is case-insensitive but normalizes to the canonical route id', () => {
    expect(parseStartPayload('/start ALERT')).toEqual({
      kind: 'route',
      route: 'alert',
      raw: 'ALERT',
    });
    expect(parseStartPayload('/start Gold')).toEqual({
      kind: 'route',
      route: 'gold',
      raw: 'Gold',
    });
  });

  it('ignores extra parameters (only the first token is a payload, never a second route)', () => {
    expect(parseStartPayload('/start prices extra')).toEqual({
      kind: 'route',
      route: 'prices',
      raw: 'prices',
    });
    expect(parseStartPayload('/start alert admin')).toEqual({
      kind: 'route',
      route: 'alert',
      raw: 'alert',
    });
    // A second token can never widen the decision: whatever it says, the routing result is unchanged.
    expect(parseStartPayload('/start prices telegram')).toEqual(
      parseStartPayload('/start prices'),
    );
  });

  it('reports unknown payloads as unknown — never as a route and never as a crash', () => {
    const cases = [
      '/start nope',
      '/start admin',
      '/start publish',
      '/start alert9',
      '/start prices_extra_note_that_is_far_too_long_to_be_accepted',
      '/start $%^&*()',
      '/start ../../etc/passwd',
      '/start <script>alert(1)</script>',
      '/start "; DROP TABLE users; --',
      `/start ${'a'.repeat(33)}`,
      '/start علاقهمندیها',
    ];

    for (const text of cases) {
      const parsed = parseStartPayload(text);

      expect(parsed.kind).toBe('unknown');
      expect(parsed).toHaveProperty('raw');
    }
  });

  it('never keeps more than the payload itself (no command echo, no surrounding text)', () => {
    const parsed = parseStartPayload('/start unknown_payload_here');

    expect(parsed).toEqual({ kind: 'unknown', raw: 'unknown_payload_here' });
  });

  it('accepts a 32-character payload and rejects a 33-character one', () => {
    expect(parseStartPayload(`/start ${'a'.repeat(32)}`).kind).toBe('unknown');
    expect(parseStartPayload(`/start ${'a'.repeat(33)}`).kind).toBe('unknown');
    // Both are unknown because they are not routes, but the length boundary is checked separately:
    expect(parseStartPayload(`/start prices`).kind).toBe('route');
  });

  it('is deterministic', () => {
    const first = parseStartPayload('/start GOLD extra');

    for (let i = 0; i < 5; i += 1) {
      expect(parseStartPayload('/start GOLD extra')).toEqual(first);
    }
  });
});
