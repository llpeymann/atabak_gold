import { Logger } from '@nestjs/common';

import {
  CtaPolicyService,
  CTA_LABELS,
  groupOfSubject,
} from './cta-policy.service';
import { createAppConfigService, EnvMap } from '../testing/test-doubles';
import { ContentItem, MessageType } from './channel.types';

/**
 * Phase 6 — the channel-side CTA policy (§4.1, §13.3).
 *
 * The policy decides *whether* a publication may carry a bot button and *where* it leads. It never
 * builds URLs and never reads market data, which is why it can be tested as a pure decision table.
 */

const policy = (env: EnvMap = {}) =>
  new CtaPolicyService(createAppConfigService(env));

const contentItem = (overrides: Partial<ContentItem> = {}): ContentItem =>
  ({
    id: 'cnt_policy_1',
    type: 'EDUCATIONAL',
    title: 'آموزش',
    body: 'متن آموزش',
    status: 'PENDING',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  }) as ContentItem;

describe('CTA policy defaults (§4.1)', () => {
  it('refines a price update by the subject group of the publication', () => {
    const service = policy();

    expect(
      service.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_GOLD_18K'],
      }),
    ).toEqual({
      route: 'gold',
      labelFa: CTA_LABELS.gold,
    });
    expect(
      service.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_COIN_EMAMI'],
      }),
    ).toEqual({
      route: 'coin',
      labelFa: CTA_LABELS.coin,
    });
  });

  it('falls back to the full price list for mixed, unknown or empty subject lists', () => {
    const service = policy();

    expect(
      service.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_GOLD_18K', 'IR_COIN_EMAMI'],
      }),
    ).toEqual({
      route: 'prices',
      labelFa: CTA_LABELS.prices,
    });
    expect(
      service.decide({ messageType: 'PRICE_UPDATE', subjects: [] })?.route,
    ).toBe('prices');
    expect(
      service.decide({ messageType: 'PRICE_UPDATE', subjects: ['USDT_IRT'] })
        ?.route,
    ).toBe('prices');
  });

  it('never attaches the alert CTA to routine price updates (the alert route is opt-in)', () => {
    const service = policy();

    for (const type of [
      'PRICE_UPDATE',
      'MARKET_MOVEMENT',
      'DAILY_RANGE',
      'DAILY_REPORT',
    ] as MessageType[]) {
      expect(
        service.decide({ messageType: type, subjects: ['IR_GOLD_18K'] })?.route,
      ).not.toBe('alert');
    }
  });

  it('leaves unrelated content without any button by default', () => {
    const service = policy();

    expect(service.decide({ messageType: 'EDUCATIONAL' })).toBeNull();
    expect(service.decide({ messageType: 'BRANDED' })).toBeNull();
    expect(service.decide({ messageType: 'NIGHTLY_ANALYSIS' })?.route).toBe(
      'prices',
    );
  });

  it('labels every route with the real destination (no generic "click here")', () => {
    for (const route of [
      'alert',
      'prices',
      'coin',
      'gold',
      'channel',
    ] as const) {
      expect(CTA_LABELS[route].length).toBeGreaterThan(3);
    }

    expect(groupOfSubject('XAUUSD')).toBe('gold');
    expect(groupOfSubject('IR_GOLD_MELTED')).toBe('gold');
    expect(groupOfSubject('IR_COIN_HALF')).toBe('coin');
    // everything that is not a gold or a coin subject is ungrouped — never a wrong destination
    expect(groupOfSubject('USD')).toBeNull();
    expect(groupOfSubject('EUR')).toBeNull();
    expect(groupOfSubject('')).toBeNull();
  });
});

describe('CTA policy overrides and switches (§4.1, §12)', () => {
  it('honours an explicit per-type route override', () => {
    const service = policy({ CHANNEL_CTA_ROUTES: 'DAILY_REPORT=alert' });

    expect(service.decide({ messageType: 'DAILY_REPORT' })).toEqual({
      route: 'alert',
      labelFa: CTA_LABELS.alert,
    });
  });

  it('honours a per-type "none" override', () => {
    const service = policy({ CHANNEL_CTA_ROUTES: 'PRICE_UPDATE=none' });

    expect(
      service.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_GOLD_18K'],
      }),
    ).toBeNull();
  });

  it('lets explicit editorial content win over the configuration', () => {
    const service = policy({ CHANNEL_CTA_ROUTES: 'EDUCATIONAL=none' });

    expect(
      service.decide({
        messageType: 'EDUCATIONAL',
        content: contentItem({ ctaRoute: 'alert' }),
      }),
    ).toEqual({ route: 'alert', labelFa: CTA_LABELS.alert });
  });

  it('lets a content item silence the button even when the type would carry one', () => {
    const service = policy();

    expect(
      service.decide({
        messageType: 'PRICE_UPDATE',
        content: contentItem({ ctaRoute: 'none' }),
      }),
    ).toBeNull();
  });

  it('treats `auto` (or an absent choice) as "use the registry default"', () => {
    const service = policy();

    expect(
      service.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_GOLD_18K'],
        content: contentItem({ ctaRoute: 'auto' }),
      })?.route,
    ).toBe('gold');
    expect(
      service.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_GOLD_18K'],
        content: null,
      })?.route,
    ).toBe('gold');
  });

  it('returns no decision at all when the CTA feature is switched off', () => {
    const service = policy({ CHANNEL_CTA_ENABLED: 'false' });

    expect(
      service.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_GOLD_18K'],
      }),
    ).toBeNull();
    expect(
      service.decide({
        messageType: 'EDUCATIONAL',
        content: contentItem({ ctaRoute: 'alert' }),
      }),
    ).toBeNull();
    expect(service.enabled).toBe(false);
  });

  it('never returns a label without a route, and every label names the route it leads to', () => {
    const service = policy();
    const types: MessageType[] = [
      'PRICE_UPDATE',
      'MARKET_MOVEMENT',
      'DAILY_RANGE',
      'DAILY_REPORT',
      'EDUCATIONAL',
      'BRANDED',
      'NIGHTLY_ANALYSIS',
    ];

    for (const messageType of types) {
      const decision = service.decide({
        messageType,
        subjects: ['IR_GOLD_18K'],
      });

      if (decision) {
        // The label is always the registry label of the route that was chosen: no generic caption,
        // no label without a destination.
        expect(decision.labelFa).toBe(CTA_LABELS[decision.route]);
        expect(decision.labelFa.length).toBeGreaterThan(0);
      }
    }
  });

  it('is pure: deciding never mutates the content item it is given', () => {
    const item = contentItem({ ctaRoute: 'alert' });
    const snapshot = JSON.stringify(item);

    policy().decide({
      messageType: 'EDUCATIONAL',
      subjects: [],
      content: item,
    });

    expect(JSON.stringify(item)).toBe(snapshot);
  });

  it('logs the resolved policy without any secret', () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    policy({ BALE_BOT_TOKEN: '123456:SHOULD-NEVER-LOG' }).logPolicy();

    const line = String(log.mock.calls[0]?.[0] ?? '');

    expect(line).toContain('Channel CTAs: enabled');
    expect(line).toContain('PRICE_UPDATE');
    expect(line).not.toContain('SHOULD-NEVER-LOG');
    expect(line).not.toContain('123456');

    log.mockRestore();
  });

  it('describes the default policy of each type for the admin surface', () => {
    const service = policy();

    expect(service.describeDefault('EDUCATIONAL')).toContain('بدون دکمه');
    expect(service.describeDefault('PRICE_UPDATE')).toContain('گروه نمادها');
    expect(service.describeDefault('DAILY_REPORT')).toContain('prices');
  });
});
