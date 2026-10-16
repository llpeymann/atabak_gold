import {
  EnvironmentValidationError,
  REFERRAL_DEFAULTS,
  parseCtaRouteOverrides,
  parseSymbolUnits,
  parseThresholdOverrides,
  validateEnvironment,
} from './env.validation';

const validEnv = (): Record<string, unknown> => ({
  PRICE_API_URL: 'https://api.example.test/prices',
  BALE_BOT_TOKEN: 'bale-token',
  BALE_CHANNEL_ID: 'bale-channel',
});

describe('validateEnvironment', () => {
  it.each(['PRICE_API_URL', 'BALE_BOT_TOKEN', 'BALE_CHANNEL_ID'])(
    'fails startup with a clear message when %s is missing',
    (key) => {
      const env = validEnv();
      delete env[key];

      expect(() => validateEnvironment(env)).toThrow(
        new EnvironmentValidationError(
          `Missing required environment variable: ${key}`,
        ),
      );
    },
  );

  it('treats blank values as missing', () => {
    expect(() =>
      validateEnvironment({ ...validEnv(), BALE_CHANNEL_ID: '   ' }),
    ).toThrow('Missing required environment variable: BALE_CHANNEL_ID');
  });

  it('applies documented defaults', () => {
    const env = validateEnvironment(validEnv());

    expect(env.PORT).toBe('3000');
    expect(env.PRICE_API_TIMEOUT_MS).toBe('20000');
    expect(env.PRICE_API_MAX_ATTEMPTS).toBe('3');
    expect(env.PRICE_API_RETRY_DELAY_MS).toBe('1500');
    expect(env.PRICE_API_UNIT).toBe('RIAL');
    expect(env.PRICE_DISPLAY_UNIT).toBe('RIAL');
    expect(env.DELIVERY_TIMEOUT_MS).toBe('20000');
  });

  it('rejects an invalid PRICE_API_URL', () => {
    expect(() =>
      validateEnvironment({ ...validEnv(), PRICE_API_URL: 'not-a-url' }),
    ).toThrow(/Invalid PRICE_API_URL/);
  });

  it('rejects a non-http(s) protocol', () => {
    expect(() =>
      validateEnvironment({
        ...validEnv(),
        PRICE_API_URL: 'ftp://api.example.test/prices',
      }),
    ).toThrow(/protocol "ftp:" is not supported/);
  });

  it('rejects out-of-range or non-integer numbers', () => {
    expect(() => validateEnvironment({ ...validEnv(), PORT: '70000' })).toThrow(
      /Invalid PORT/,
    );
    expect(() => validateEnvironment({ ...validEnv(), PORT: 'abc' })).toThrow(
      /Invalid PORT/,
    );
    expect(() =>
      validateEnvironment({ ...validEnv(), PRICE_API_MAX_ATTEMPTS: '0' }),
    ).toThrow(/Invalid PRICE_API_MAX_ATTEMPTS/);
  });

  it('rejects an unknown money unit', () => {
    expect(() =>
      validateEnvironment({ ...validEnv(), PRICE_DISPLAY_UNIT: 'DOLLAR' }),
    ).toThrow(/Invalid PRICE_DISPLAY_UNIT/);
  });

  it('does not fail when Telegram is only partially configured (delivery simply stays off)', () => {
    const env = validateEnvironment({
      ...validEnv(),
      TELEGRAM_BOT_TOKEN: 'tg-token',
    });

    expect(env.TELEGRAM_BOT_TOKEN).toBe('tg-token');
    expect(env.TELEGRAM_CHANNEL_ID).toBeUndefined();
  });
});

describe('parseSymbolUnits', () => {
  it('returns an empty map for blank input', () => {
    expect(parseSymbolUnits('')).toEqual({});
    expect(parseSymbolUnits(undefined)).toEqual({});
  });

  it('parses a symbol/unit list', () => {
    expect(parseSymbolUnits('USDT_IRT=TOMAN, USD=TOMAN')).toEqual({
      USDT_IRT: 'TOMAN',
      USD: 'TOMAN',
    });
  });

  it('rejects malformed entries', () => {
    expect(() => parseSymbolUnits('USDT_IRT')).toThrow(
      /Invalid PRICE_SYMBOL_UNITS entry/,
    );
    expect(() => parseSymbolUnits('USDT_IRT=DOLLAR')).toThrow(
      /Invalid PRICE_SYMBOL_UNITS entry/,
    );
  });
});

describe('Phase 1 market reliability variables', () => {
  const validEnv = () => ({
    PRICE_API_URL: 'https://api.example.test/prices',
    BALE_BOT_TOKEN: 'bale-token',
    BALE_CHANNEL_ID: 'bale-channel',
  });

  it('applies documented reliability defaults', () => {
    const env = validateEnvironment(validEnv());

    expect(env.PRICE_MAX_CHANGE_PERCENT).toBe('8');
    expect(env.PRICE_CROSS_DAY_CHANGE_MULTIPLIER).toBe('2');
    expect(env.PRICE_STALE_AFTER_MINUTES).toBe('45');
    expect(env.ANOMALY_ALERT_COOLDOWN_MINUTES).toBe('30');
    expect(env.MARKET_STATE_FILE).toBe('./data/market-state.json');
  });

  it('rejects out-of-range thresholds', () => {
    expect(() =>
      validateEnvironment({ ...validEnv(), PRICE_MAX_CHANGE_PERCENT: '0' }),
    ).toThrow(/Invalid PRICE_MAX_CHANGE_PERCENT/);
    expect(() =>
      validateEnvironment({ ...validEnv(), PRICE_MAX_CHANGE_PERCENT: '500' }),
    ).toThrow(/Invalid PRICE_MAX_CHANGE_PERCENT/);
    expect(() =>
      validateEnvironment({
        ...validEnv(),
        PRICE_CROSS_DAY_CHANGE_MULTIPLIER: '0.5',
      }),
    ).toThrow(/Invalid PRICE_CROSS_DAY_CHANGE_MULTIPLIER/);
  });

  it('accepts a non-integer change percentage', () => {
    expect(
      validateEnvironment({ ...validEnv(), PRICE_MAX_CHANGE_PERCENT: '7.5' }),
    ).toMatchObject({
      PRICE_MAX_CHANGE_PERCENT: '7.5',
    });
  });

  it('rejects malformed threshold overrides', () => {
    expect(() =>
      validateEnvironment({
        ...validEnv(),
        PRICE_THRESHOLD_OVERRIDES: 'XAUUSD',
      }),
    ).toThrow(/Invalid PRICE_THRESHOLD_OVERRIDES entry/);
    expect(() =>
      validateEnvironment({
        ...validEnv(),
        PRICE_THRESHOLD_OVERRIDES: 'XAUUSD=0',
      }),
    ).toThrow(/Invalid PRICE_THRESHOLD_OVERRIDES entry/);
  });

  it('parses valid threshold overrides', () => {
    expect(parseThresholdOverrides('XAUUSD=12, TRY=15')).toEqual({
      XAUUSD: 12,
      TRY: 15,
    });
    expect(parseThresholdOverrides('')).toEqual({});
  });
});

describe('Phase 6 configuration (§9)', () => {
  it('leaves every channel↔bot key disabled by default (no unverified destination)', () => {
    const env = validateEnvironment(validEnv());

    expect(env.BALE_BOT_USERNAME).toBe('');
    expect(env.TELEGRAM_BOT_USERNAME).toBe('');
    expect(env.TELEGRAM_CHANNEL_URL).toBe('');
    // The Bale channel keeps its Phase 1 default; Telegram needs its own key.
    expect(env.CHANNEL_URL).toBe('https://ble.ir/tala_atabak');
    expect(env.CHANNEL_CTA_ENABLED).toBe('true');
    expect(env.CHANNEL_CTA_ROUTES).toBe('');
    expect(env.BOT_CHANNEL_INVITE_ENABLED).toBe('true');
  });

  it('normalizes a bot username written with a leading @', () => {
    const env = validateEnvironment({
      ...validEnv(),
      BALE_BOT_USERNAME: ' @atabak_bot ',
    });

    expect(env.BALE_BOT_USERNAME).toBe('atabak_bot');
  });

  it.each([
    'atabak-bot',
    'ab',
    '1atabak_bot',
    '@',
    'atabak bot',
    'atabak_bot!',
  ])('refuses to start with the unusable bot username %s', (username) => {
    expect(() =>
      validateEnvironment({ ...validEnv(), BALE_BOT_USERNAME: username }),
    ).toThrow(/BALE_BOT_USERNAME/);
  });

  it('refuses a malformed Telegram channel link instead of guessing one', () => {
    expect(() =>
      validateEnvironment({
        ...validEnv(),
        TELEGRAM_CHANNEL_URL: 't.me/tala_atabak',
      }),
    ).toThrow(/TELEGRAM_CHANNEL_URL/);
  });

  it('accepts a valid Telegram channel link', () => {
    const env = validateEnvironment({
      ...validEnv(),
      TELEGRAM_CHANNEL_URL: 'https://t.me/tala_atabak',
    });

    expect(env.TELEGRAM_CHANNEL_URL).toBe('https://t.me/tala_atabak');
  });

  it.each(['PRICE_UPDATE=alert', 'DAILY_REPORT=none', 'EDUCATIONAL=channel'])(
    'parses the CTA override %s',
    (override) => {
      expect(() =>
        validateEnvironment({ ...validEnv(), CHANNEL_CTA_ROUTES: override }),
      ).not.toThrow();
      expect(parseCtaRouteOverrides(override)).toEqual(
        Object.fromEntries([override.split('=') as [string, string]]),
      );
    },
  );

  it.each([
    'PRICE_UPDATE=hack',
    'UNKNOWN_TYPE=gold',
    'PRICE_UPDATE',
    'PRICE_UPDATE=auto',
    'PRICE_UPDATE=gold=gold',
  ])('refuses the invalid CTA override %s', (override) => {
    expect(() =>
      validateEnvironment({ ...validEnv(), CHANNEL_CTA_ROUTES: override }),
    ).toThrow(EnvironmentValidationError);
    expect(() => parseCtaRouteOverrides(override)).toThrow(
      EnvironmentValidationError,
    );
  });

  it('keeps the CTA features switchable without touching anything else', () => {
    const env = validateEnvironment({
      ...validEnv(),
      CHANNEL_CTA_ENABLED: 'false',
      BOT_CHANNEL_INVITE_ENABLED: 'false',
    });

    expect(env.CHANNEL_CTA_ENABLED).toBe('false');
    expect(env.BOT_CHANNEL_INVITE_ENABLED).toBe('false');
  });

  it('still boots when the optional Telegram platform is entirely unconfigured', () => {
    expect(() => validateEnvironment(validEnv())).not.toThrow();
    // …and the CTA keys are optional too.
    expect(() =>
      validateEnvironment({
        ...validEnv(),
        CHANNEL_CTA_ENABLED: 'false',
        CHANNEL_CTA_ROUTES: '',
      }),
    ).not.toThrow();
  });
});

describe('Phase 7 configuration (referrals & rewards)', () => {
  it('ships the documented defaults (3 referrals per reward, 1 slot, 30-day window)', () => {
    const env = validateEnvironment(validEnv());

    expect(env.REFERRAL_ENABLED).toBe('true');
    expect(env.REFERRAL_REWARDS_ENABLED).toBe('true');
    expect(env.REFERRAL_REWARDS_PER_THRESHOLD).toBe('3');
    expect(env.REFERRAL_REWARD_BONUS_SLOTS).toBe('1');
    expect(env.REFERRAL_ACTIVE_WINDOW_DAYS).toBe('30');
    expect(env.REFERRAL_MAX_BONUS_SLOTS).toBe('50');
    // No destination is invented: referral links stay off until an operator configures them.
    expect(env.BALE_REFERRAL_BOT_USERNAME).toBe('');
    expect(env.TELEGRAM_REFERRAL_BOT_USERNAME).toBe('');
  });

  it('normalizes referral bot usernames exactly like the Phase 6 destinations', () => {
    const env = validateEnvironment({
      ...validEnv(),
      BALE_REFERRAL_BOT_USERNAME: ' @atabak_bot ',
      TELEGRAM_REFERRAL_BOT_USERNAME: 'atabak_tg_bot',
    });

    expect(env.BALE_REFERRAL_BOT_USERNAME).toBe('atabak_bot');
    expect(env.TELEGRAM_REFERRAL_BOT_USERNAME).toBe('atabak_tg_bot');
  });

  it.each([
    'atabak-bot',
    'ab',
    '1atabak_bot',
    '@',
    'atabak bot',
    'atabak_bot!',
  ])('refuses to start with the unusable referral username %s', (username) => {
    expect(() =>
      validateEnvironment({
        ...validEnv(),
        BALE_REFERRAL_BOT_USERNAME: username,
      }),
    ).toThrow(/BALE_REFERRAL_BOT_USERNAME/);
  });

  it.each(['0', '-1', 'abc', '3.5', '10001'])(
    'refuses the invalid reward threshold %s (a zero would make everyone eligible)',
    (value) => {
      expect(() =>
        validateEnvironment({
          ...validEnv(),
          REFERRAL_REWARDS_PER_THRESHOLD: value,
        }),
      ).toThrow(/REFERRAL_REWARDS_PER_THRESHOLD/);
    },
  );

  it.each(['0', '-1', 'abc', '101'])(
    'refuses the invalid bonus slot count %s (a reward must add something)',
    (value) => {
      expect(() =>
        validateEnvironment({
          ...validEnv(),
          REFERRAL_REWARD_BONUS_SLOTS: value,
        }),
      ).toThrow(/REFERRAL_REWARD_BONUS_SLOTS/);
    },
  );

  it.each(['0', '-5', 'abc', '5000'])(
    'refuses the invalid activity window %s',
    (value) => {
      expect(() =>
        validateEnvironment({
          ...validEnv(),
          REFERRAL_ACTIVE_WINDOW_DAYS: value,
        }),
      ).toThrow(/REFERRAL_ACTIVE_WINDOW_DAYS/);
    },
  );

  it.each(['0', '-1'])(
    'refuses a bonus ceiling of %s (capacity must stay bounded by a positive number)',
    (value) => {
      expect(() =>
        validateEnvironment({ ...validEnv(), REFERRAL_MAX_BONUS_SLOTS: value }),
      ).toThrow(/REFERRAL_MAX_BONUS_SLOTS/);
    },
  );

  it('accepts an explicit configuration and keeps every value verbatim', () => {
    const env = validateEnvironment({
      ...validEnv(),
      REFERRAL_ENABLED: 'false',
      REFERRAL_REWARDS_ENABLED: 'false',
      REFERRAL_REWARDS_PER_THRESHOLD: '5',
      REFERRAL_REWARD_BONUS_SLOTS: '2',
      REFERRAL_ACTIVE_WINDOW_DAYS: '7',
      REFERRAL_MAX_BONUS_SLOTS: '10',
    });

    expect(env.REFERRAL_ENABLED).toBe('false');
    expect(env.REFERRAL_REWARDS_ENABLED).toBe('false');
    expect(env.REFERRAL_REWARDS_PER_THRESHOLD).toBe('5');
    expect(env.REFERRAL_REWARD_BONUS_SLOTS).toBe('2');
    expect(env.REFERRAL_ACTIVE_WINDOW_DAYS).toBe('7');
    expect(env.REFERRAL_MAX_BONUS_SLOTS).toBe('10');
  });

  it('documents the frozen rule in one place instead of scattering it across services', () => {
    expect(REFERRAL_DEFAULTS).toEqual({
      rewardsPerThreshold: 3,
      bonusSlots: 1,
      activeWindowDays: 30,
    });
  });
});
