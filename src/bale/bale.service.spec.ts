import { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { of, throwError } from 'rxjs';

import {
  createAppConfigService,
  createHttpServiceDouble,
  EnvMap,
} from '../testing/test-doubles';
import { BaleService } from './bale.service';
import { DeliveryResult, summarizeDelivery } from './delivery-result';

const TELEGRAM_ENV: EnvMap = {
  TELEGRAM_BOT_TOKEN: 'telegram-token',
  TELEGRAM_CHANNEL_ID: 'telegram-channel',
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

const createService = (env: EnvMap = {}) => {
  const http = createHttpServiceDouble();
  const service = new BaleService(http.service, createAppConfigService(env));

  return { service, http };
};

describe('BaleService', () => {
  it('delivers to Bale only when Telegram is not configured', () => {
    const { service } = createService();

    expect(service.platforms).toEqual(['bale']);
  });

  it('delivers to both platforms when Telegram is configured', async () => {
    const { service, http } = createService(TELEGRAM_ENV);
    http.post.mockReturnValue(of({ data: { ok: true } }));

    const results = await service.sendMessage('<b>گزارش</b>');

    expect(service.platforms).toEqual(['bale', 'telegram']);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.success)).toBe(true);
    expect(summarizeDelivery(results)).toMatchObject({
      succeeded: ['bale', 'telegram'],
      failed: [],
      anySucceeded: true,
      allFailed: false,
    });
    expect(http.post).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({
        text: '<strong>گزارش</strong>',
        parse_mode: 'HTML',
        chat_id: 'bale-channel',
      }),
      expect.objectContaining({ timeout: 2000 }),
    );
  });

  it('reports a failure for the affected platform instead of masking it', async () => {
    const { service, http } = createService(TELEGRAM_ENV);
    http.post.mockImplementation((url: string) =>
      url.includes('tapi.bale.ai')
        ? throwError(() => httpError(500, { description: 'internal error' }))
        : of({ data: { ok: true } }),
    );

    const results = await service.sendMessage('message');
    const summary = summarizeDelivery(results);

    expect(summary.failed).toEqual(['bale']);
    expect(summary.succeeded).toEqual(['telegram']);
    expect(summary.anySucceeded).toBe(true);

    const baleResult = results.find(
      (result) => result.platform === 'bale',
    ) as DeliveryResult;
    expect(baleResult.success).toBe(false);
    expect(baleResult.error).toContain('HTTP 500');
    expect(baleResult.channel).toBe('bale-channel');
    expect(baleResult.messageType).toBe('text');
    expect(typeof baleResult.timestamp).toBe('string');
  });

  it('never rejects, even when every platform fails', async () => {
    const { service, http } = createService(TELEGRAM_ENV);
    http.post.mockReturnValue(throwError(() => new Error('network down')));

    const results = await service.sendMessage('message');
    const summary = summarizeDelivery(results);

    expect(summary.allFailed).toBe(true);
    expect(summary.anySucceeded).toBe(false);
    expect(results.every((result) => result.success === false)).toBe(true);
  });

  it('never leaks bot tokens into the failure description', async () => {
    const { service, http } = createService(TELEGRAM_ENV);
    http.post.mockReturnValue(
      throwError(
        () =>
          new Error(
            'connect ECONNREFUSED https://tapi.bale.ai/botbale-token/sendMessage',
          ),
      ),
    );

    const results = await service.sendMessage('message');
    const description = results[0]?.error ?? '';

    expect(description).not.toContain('bale-token');
    expect(description).toContain('***');
  });
  it('sends an operational alert to an explicit chat without touching the publication channel', async () => {
    const { service, http } = createService();
    http.post.mockReturnValue(of({ data: { ok: true } }));

    const results = await service.sendMessageTo('admin-chat', '🚨 anomaly');

    expect(results[0]).toMatchObject({ success: true, channel: 'admin-chat' });
    expect(http.post).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({ chat_id: 'admin-chat', text: '🚨 anomaly' }),
      expect.objectContaining({ timeout: 2000 }),
    );
  });

  it('reports a failure for an explicit-chat alert instead of hiding it', async () => {
    const { service, http } = createService();
    http.post.mockReturnValue(
      throwError(() => httpError(403, { description: 'chat not found' })),
    );

    const results = await service.sendMessageTo('admin-chat', 'alert');

    expect(results[0]).toMatchObject({ success: false, channel: 'admin-chat' });
    expect(results[0]?.error).toContain('HTTP 403');
  });
});

describe('summarizeDelivery', () => {
  const result = (
    platform: 'bale' | 'telegram',
    success: boolean,
  ): DeliveryResult => ({
    platform,
    channel: 'channel',
    messageType: 'text',
    timestamp: new Date().toISOString(),
    durationMs: 1,
    success,
  });

  it('summarizes a partial success truthfully', () => {
    expect(
      summarizeDelivery([result('bale', true), result('telegram', false)]),
    ).toEqual({
      succeeded: ['bale'],
      failed: ['telegram'],
      anySucceeded: true,
      allFailed: false,
    });
  });

  it('treats an empty result list as "nothing delivered"', () => {
    expect(summarizeDelivery([])).toEqual({
      succeeded: [],
      failed: [],
      anySucceeded: false,
      allFailed: true,
    });
  });
});
