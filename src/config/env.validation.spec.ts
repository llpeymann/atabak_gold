import {
  EnvironmentValidationError,
  parseSymbolUnits,
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
