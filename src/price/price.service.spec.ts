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

const PAYLOAD = { gold: [{ symbol: 'IR_GOLD_18K', price: 17981900 }] };

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

describe('PriceService (provider: transport only)', () => {
  it('returns the untouched payload with receipt time and a sanitized source', async () => {
    const { service, http } = createService();
    http.get.mockReturnValueOnce(of({ data: PAYLOAD }));

    const fetch = await service.fetchRawPayload();

    expect(fetch.payload).toBe(PAYLOAD);
    expect(fetch.source).toBe('https://api.example.test/prices');
    expect(Number.isNaN(Date.parse(fetch.receivedAt))).toBe(false);
  });

  it('does not validate or transform the payload (that is the market layer’s job)', async () => {
    const { service, http } = createService();
    http.get.mockReturnValueOnce(of({ data: { completely: 'different' } }));

    const fetch = await service.fetchRawPayload();

    expect(fetch.payload).toEqual({ completely: 'different' });
  });

  it('retries a timeout and succeeds on a later attempt', async () => {
    const { service, http } = createService();
    http.get
      .mockReturnValueOnce(throwError(() => timeoutError()))
      .mockReturnValueOnce(of({ data: PAYLOAD }));

    const fetch = await service.fetchRawPayload();

    expect(http.get).toHaveBeenCalledTimes(2);
    expect(fetch.payload).toEqual(PAYLOAD);
  });

  it('retries transient HTTP 5xx responses', async () => {
    const { service, http } = createService();
    http.get
      .mockReturnValueOnce(throwError(() => httpError(503)))
      .mockReturnValueOnce(of({ data: PAYLOAD }));

    await service.fetchRawPayload();

    expect(http.get).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent 4xx failure', async () => {
    const { service, http } = createService();
    http.get.mockReturnValue(
      throwError(() => httpError(400, { message: 'bad request' })),
    );

    await expect(service.fetchRawPayload()).rejects.toMatchObject({
      status: 400,
      retryable: false,
    });
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of attempts', async () => {
    const { service, http } = createService();
    http.get.mockReturnValue(throwError(() => httpError(500)));

    const request = service.fetchRawPayload();

    await expect(request).rejects.toBeInstanceOf(PriceApiError);
    await expect(request).rejects.toMatchObject({ attempts: 3 });
    expect(http.get).toHaveBeenCalledTimes(3);
  });

  it('sends the configured timeout to the HTTP client', async () => {
    const { service, http } = createService({ PRICE_API_TIMEOUT_MS: '1234' });
    http.get.mockReturnValueOnce(of({ data: PAYLOAD }));

    await service.fetchRawPayload();

    expect(http.get).toHaveBeenCalledWith(
      'https://api.example.test/prices',
      expect.objectContaining({ timeout: 1234 }),
    );
  });
});
