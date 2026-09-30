import { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { of, throwError } from 'rxjs';

import {
  createAppConfigService,
  createHttpServiceDouble,
  EnvMap,
} from '../testing/test-doubles';
import { PriceApiError } from './price.error';
import { PriceService } from './price.service';

const CONFIG: EnvMap = {
  PRICE_API_MAX_ATTEMPTS: '3',
  PRICE_API_RETRY_DELAY_MS: '1',
  PRICE_API_TIMEOUT_MS: '2000',
};

const PAYLOAD = {
  gold: [
    {
      symbol: 'IR_GOLD_18K',
      name: 'طلای ۱۸ عیار',
      price: 17981900,
      change_percent: 1.234,
    },
    { symbol: 'IR_GOLD_BROKEN', price: 'not-a-number' },
    { symbol: 'IR_GOLD_24K', price: '18,500,000' },
  ],
  currency: [{ symbol: 'USDT_IRT', price: 1000 }],
};

const axiosResponse = (status: number, data: unknown): AxiosResponse => ({
  status,
  statusText: '',
  data,
  headers: {},
  config: {} as unknown as InternalAxiosRequestConfig,
});

const httpError = (status: number, data: unknown = {}): AxiosError =>
  new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    {} as unknown as InternalAxiosRequestConfig,
    undefined,
    axiosResponse(status, data),
  );

const timeoutError = (): AxiosError =>
  new AxiosError(
    'timeout of 2000ms exceeded',
    'ECONNABORTED',
    {} as unknown as InternalAxiosRequestConfig,
  );

const createService = (overrides: EnvMap = {}) => {
  const http = createHttpServiceDouble();
  const config = createAppConfigService({ ...CONFIG, ...overrides });

  return { service: new PriceService(http.service, config), http };
};

describe('PriceService', () => {
  it('normalizes the payload into typed market data', async () => {
    const { service, http } = createService();
    http.get.mockReturnValueOnce(of({ data: PAYLOAD }));

    const data = await service.getMarketData();

    // The item without a usable price is dropped instead of being published as a fake value.
    expect(data.gold.map((item) => item.symbol)).toEqual([
      'IR_GOLD_18K',
      'IR_GOLD_24K',
    ]);
    expect(data.gold[0]).toEqual({
      symbol: 'IR_GOLD_18K',
      name: 'طلای ۱۸ عیار',
      priceInRial: 17981900,
      changePercent: 1.234,
    });
    expect(data.gold[1]?.priceInRial).toBe(18500000);
    expect(data.currency[0]).toEqual({
      symbol: 'USDT_IRT',
      priceInRial: 1000,
      changePercent: null,
    });
    expect(typeof data.fetchedAt).toBe('string');
  });

  it('applies per-symbol unit overrides when converting to the canonical Rial value', async () => {
    const { service, http } = createService({
      PRICE_SYMBOL_UNITS: 'USDT_IRT=TOMAN',
    });
    http.get.mockReturnValueOnce(of({ data: PAYLOAD }));

    const data = await service.getMarketData();

    // 1000 Toman === 10000 Rial
    expect(data.currency[0]?.priceInRial).toBe(10000);
  });

  it('retries a timeout and succeeds on a later attempt', async () => {
    const { service, http } = createService();
    http.get
      .mockReturnValueOnce(throwError(() => timeoutError()))
      .mockReturnValueOnce(of({ data: PAYLOAD }));

    const data = await service.getMarketData();

    expect(http.get).toHaveBeenCalledTimes(2);
    expect(data.gold.length).toBeGreaterThan(0);
  });

  it('retries transient HTTP 5xx responses', async () => {
    const { service, http } = createService();
    http.get
      .mockReturnValueOnce(throwError(() => httpError(503)))
      .mockReturnValueOnce(of({ data: PAYLOAD }));

    await service.getMarketData();

    expect(http.get).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent 4xx failure', async () => {
    const { service, http } = createService();
    http.get.mockReturnValue(
      throwError(() => httpError(400, { message: 'bad request' })),
    );

    await expect(service.getMarketData()).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of attempts and reports the failure', async () => {
    const { service, http } = createService();
    http.get.mockReturnValue(throwError(() => httpError(500)));

    const request = service.getMarketData();

    await expect(request).rejects.toBeInstanceOf(PriceApiError);
    await expect(request).rejects.toMatchObject({ attempts: 3 });
    expect(http.get).toHaveBeenCalledTimes(3);
  });

  it('rejects a malformed payload instead of publishing partial nonsense', async () => {
    const { service, http } = createService();
    http.get.mockReturnValueOnce(
      of({ data: { gold: 'not-an-array', currency: [] } }),
    );

    await expect(service.getMarketData()).rejects.toThrow(
      /invalid "gold" section/,
    );
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('never resolves with an empty/fake price set', async () => {
    const { service, http } = createService();
    http.get.mockReturnValueOnce(
      of({
        data: { gold: [{ symbol: 'IR_GOLD_18K', price: null }], currency: [] },
      }),
    );

    await expect(service.getMarketData()).rejects.toThrow(/no usable prices/);
  });

  it('rejects a non-object payload', async () => {
    const { service, http } = createService();
    http.get.mockReturnValueOnce(of({ data: 'unexpected' }));

    await expect(service.getMarketData()).rejects.toThrow(/unexpected payload/);
  });

  it('sends the configured timeout to the HTTP client', async () => {
    const { service, http } = createService({ PRICE_API_TIMEOUT_MS: '1234' });
    http.get.mockReturnValueOnce(of({ data: PAYLOAD }));

    await service.getMarketData();

    expect(http.get).toHaveBeenCalledWith(
      'https://api.example.test/prices',
      expect.objectContaining({ timeout: 1234 }),
    );
  });
});
