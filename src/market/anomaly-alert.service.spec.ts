import { Logger } from '@nestjs/common';

import { AnomalyAlertService } from './anomaly-alert.service';
import { PriceEvaluation } from './market.types';
import {
  createAppConfigService,
  createBaleServiceDouble,
} from '../testing/test-doubles';

const evaluation = (
  overrides: Partial<PriceEvaluation> = {},
): PriceEvaluation => ({
  symbol: 'IR_GOLD_18K',
  label: 'طلای ۱۸ عیار',
  section: 'gold',
  unit: 'RIAL',
  accepted: false,
  reason: 'EXCESSIVE_CHANGE',
  detail: 'change of 35.29% exceeds the allowed 10%',
  rejectedValue: 23_000_000,
  previousPrice: 17_000_000,
  baseline: 'SAME_DAY',
  maxChangePercent: 10,
  absoluteChange: 6_000_000,
  percentageChange: 35.29,
  direction: 'UP',
  evaluatedAt: '2026-09-30T09:00:00.000Z',
  ...overrides,
});

const createService = (env = {}) => {
  const config = createAppConfigService(env);
  const bale = createBaleServiceDouble();

  return {
    service: new AnomalyAlertService(config, bale.service),
    bale,
    config,
  };
};

describe('AnomalyAlertService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends an operational alert to the configured admin chat', async () => {
    const { service, bale } = createService({
      ANOMALY_ALERT_CHAT_ID: 'admin-chat',
    });

    const delivered = await service.reportAnomaly(evaluation());

    expect(delivered).toBe(true);
    expect(bale.sendMessageTo).toHaveBeenCalledTimes(1);
    const [chatId, message] = bale.sendMessageTo.mock.calls[0] ?? [];
    expect(chatId).toBe('admin-chat');
    expect(message).toContain('هشدار ناهنجاری');
    expect(message).toContain('IR_GOLD_18K');
    expect(message).toContain('REJECTED');
    expect(message).toContain('EXCESSIVE_CHANGE');
  });

  it('never publishes the alert to the public channel', async () => {
    const { service, bale } = createService({
      ANOMALY_ALERT_CHAT_ID: 'admin-chat',
    });

    await service.reportAnomaly(evaluation());

    expect(bale.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to an error log when no admin chat is configured', async () => {
    const { service, bale } = createService();
    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    const delivered = await service.reportAnomaly(evaluation());

    expect(delivered).toBe(true);
    expect(bale.sendMessageTo).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('PRICE ANOMALY'),
    );
  });

  describe('spam protection', () => {
    it('suppresses identical anomalies inside the cooldown window', async () => {
      const { service, bale } = createService({
        ANOMALY_ALERT_COOLDOWN_MINUTES: '30',
        ANOMALY_ALERT_CHAT_ID: 'admin-chat',
      });
      const start = new Date('2026-09-30T09:00:00Z');

      const first = await service.reportAnomaly(evaluation(), start);
      const second = await service.reportAnomaly(
        evaluation(),
        new Date('2026-09-30T09:05:00Z'),
      );
      const third = await service.reportAnomaly(
        evaluation(),
        new Date('2026-09-30T09:29:59Z'),
      );

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(third).toBe(false);
      expect(bale.sendMessageTo).toHaveBeenCalledTimes(1);
    });

    it('sends again after the cooldown and reports how many were suppressed', async () => {
      const { service, bale } = createService({
        ANOMALY_ALERT_COOLDOWN_MINUTES: '30',
        ANOMALY_ALERT_CHAT_ID: 'admin-chat',
      });

      await service.reportAnomaly(
        evaluation(),
        new Date('2026-09-30T09:00:00Z'),
      );
      await service.reportAnomaly(
        evaluation(),
        new Date('2026-09-30T09:10:00Z'),
      );
      const third = await service.reportAnomaly(
        evaluation(),
        new Date('2026-09-30T09:35:00Z'),
      );

      expect(third).toBe(true);
      expect(bale.sendMessageTo).toHaveBeenCalledTimes(2);
      const message = bale.sendMessageTo.mock.calls[1]?.[1] ?? '';
      expect(message).toContain('۱');
      expect(message).toContain('ادغام شد');
    });

    it('tracks a different reason for the same symbol independently', async () => {
      const { service, bale } = createService({
        ANOMALY_ALERT_COOLDOWN_MINUTES: '30',
        ANOMALY_ALERT_CHAT_ID: 'admin-chat',
      });

      await service.reportAnomaly(
        evaluation(),
        new Date('2026-09-30T09:00:00Z'),
      );
      await service.reportAnomaly(
        evaluation({ reason: 'OUT_OF_RANGE', detail: 'above bound' }),
        new Date('2026-09-30T09:01:00Z'),
      );

      expect(bale.sendMessageTo).toHaveBeenCalledTimes(2);
      expect(service.activeCooldowns).toBe(2);
    });

    it('reports a delivery failure when the alert cannot be sent', async () => {
      const config = createAppConfigService({
        ANOMALY_ALERT_CHAT_ID: 'admin-chat',
      });
      const bale = createBaleServiceDouble([
        {
          platform: 'bale',
          channel: 'admin-chat',
          messageType: 'text',
          timestamp: new Date().toISOString(),
          durationMs: 1,
          success: false,
          error: 'HTTP 500',
        },
      ]);
      const service = new AnomalyAlertService(config, bale.service);
      const errorSpy = jest.spyOn(Logger.prototype, 'error');

      const delivered = await service.reportAnomaly(evaluation());

      expect(delivered).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not deliver the anomaly alert'),
      );
    });
  });
});
