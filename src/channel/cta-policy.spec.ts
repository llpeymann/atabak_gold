import { Logger } from '@nestjs/common';

import { createAppConfigService, EnvMap } from '../testing/test-doubles';
import {
  CTA_LABELS,
  CtaPolicyService,
  groupOfSubject,
} from './cta-policy.service';
import { ContentItem, MessageType } from './channel.types';

/**
 * §13.3 — the CTA policy (Channel → Bot eligibility).
 *
 * The policy decides *whether* a publication may carry a button and *which intent* it carries; it never
 * builds a URL and never touches market data. The rules under test are the acceptance rules of §4.1:
 * type-based eligibility, no alert CTA on routine price updates, no price CTA on unrelated editorial
 * content, admin overrides, configuration overrides, and a kill switch.
 */

const build = (env: EnvMap = {}): CtaPolicyService =>
  new CtaPolicyService(createAppConfigService(env));

const content = (overrides: Partial<ContentItem> = {}): ContentItem => ({
  id: 'cnt_1',
  messageType: 'EDUCATIONAL',
  title: 'عنوان',
  body: 'متن',
  mediaUrl: null,
  includeMarketData: false,
  revision: 1,
  status: 'DRAFT',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  approvedAt: null,
  approvedBy: null,
  scheduledAt: null,
  reportingDate: null,
  lastJobId: null,
  cancelledAt: null,
  lastError: null,
  ...overrides,
});

describe('CTA subject groups (§4.1 rule 2)', () => {
  it('recognizes gold and coin subjects from the registry prefixes', () => {
    expect(groupOfSubject('IR_GOLD_18K')).toBe('gold');
    expect(groupOfSubject('XAU_USD')).toBe('gold');
    expect(groupOfSubject('IR_COIN_EMAMI')).toBe('coin');
  });

  it('treats everything else as ungrouped', () => {
    expect(groupOfSubject('USD')).toBeNull();
    expect(groupOfSubject('EUR')).toBeNull();
    expect(groupOfSubject('')).toBeNull();
  });
});

describe('CTA policy (§4.1)', () => {
  it('sends a gold-only price update to the gold screen', () => {
    const decision = build().decide({
      messageType: 'PRICE_UPDATE',
      subjects: ['IR_GOLD_18K', 'IR_GOLD_24K'],
    });

    expect(decision).toEqual({ route: 'gold', labelFa: CTA_LABELS.gold });
  });

  it('sends a coin-only price update to the coin screen', () => {
    const decision = build().decide({
      messageType: 'PRICE_UPDATE',
      subjects: ['IR_COIN_EMAMI'],
    });

    expect(decision).toEqual({ route: 'coin', labelFa: CTA_LABELS.coin });
  });

  it('sends a mixed or general price update to the full price list', () => {
    const policy = build();

    expect(
      policy.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_GOLD_18K', 'USD'],
      }),
    ).toEqual({ route: 'prices', labelFa: CTA_LABELS.prices });
    expect(
      policy.decide({ messageType: 'PRICE_UPDATE', subjects: [] }),
    ).toEqual({
      route: 'prices',
      labelFa: CTA_LABELS.prices,
    });
  });

  it('never attaches the alert CTA to a routine price update', () => {
    const policy = build();
    const decisions = (
      [
        ['PRICE_UPDATE', []],
        ['PRICE_UPDATE', ['IR_GOLD_18K']],
        ['PRICE_UPDATE', ['IR_COIN_EMAMI']],
        ['PRICE_UPDATE', ['USD', 'EUR']],
        ['MARKET_MOVEMENT', ['IR_GOLD_18K']],
        ['DAILY_RANGE', ['IR_COIN_EMAMI']],
        ['DAILY_REPORT', []],
        ['NIGHTLY_ANALYSIS', []],
      ] as [MessageType, string[]][]
    ).map(([messageType, subjects]) =>
      policy.decide({ messageType, subjects }),
    );

    for (const decision of decisions) {
      expect(decision?.route).not.toBe('alert');
    }
    expect(decisions.filter((decision) => decision !== null)).toHaveLength(
      decisions.length,
    );
  });

  it('leaves unrelated editorial content without a button', () => {
    const policy = build();

    expect(
      policy.decide({ messageType: 'EDUCATIONAL', subjects: [] }),
    ).toBeNull();
    expect(policy.decide({ messageType: 'BRANDED', subjects: [] })).toBeNull();
    // …even when the post happens to be about gold: the type decides, not the wording.
    expect(
      policy.decide({ messageType: 'EDUCATIONAL', subjects: ['IR_GOLD_18K'] }),
    ).toBeNull();
  });

  it('routes the nightly analysis to the price list', () => {
    expect(
      build().decide({ messageType: 'NIGHTLY_ANALYSIS', subjects: [] }),
    ).toEqual({
      route: 'prices',
      labelFa: CTA_LABELS.prices,
    });
  });

  it('honours an explicit admin choice, including the alert promotion', () => {
    const policy = build();

    expect(
      policy.decide({
        messageType: 'EDUCATIONAL',
        subjects: [],
        content: content({ ctaRoute: 'alert' }),
      }),
    ).toEqual({ route: 'alert', labelFa: CTA_LABELS.alert });

    expect(
      policy.decide({
        messageType: 'BRANDED',
        subjects: [],
        content: content({ ctaRoute: 'channel', messageType: 'BRANDED' }),
      }),
    ).toEqual({ route: 'channel', labelFa: CTA_LABELS.channel });
  });

  it('lets an admin silence a type that would carry a button by default', () => {
    const policy = build();

    expect(
      policy.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_GOLD_18K'],
        content: content({ ctaRoute: 'none', messageType: 'PRICE_UPDATE' }),
      }),
    ).toBeNull();
  });

  it('treats `auto` and a missing value identically (documents written before Phase 6)', () => {
    const policy = build();
    const input = { messageType: 'DAILY_REPORT' as MessageType, subjects: [] };

    const auto = policy.decide({
      ...input,
      content: content({ ctaRoute: 'auto' }),
    });
    const legacy = policy.decide({
      ...input,
      content: content({ ctaRoute: undefined }),
    });
    const empty = policy.decide({
      ...input,
      content: content({ ctaRoute: null as never }),
    });

    expect(auto).toEqual(legacy);
    expect(legacy).toEqual(empty);
    expect(legacy?.route).toBe('prices');
  });

  it('applies a configured per-type override, and lets it disable a type', () => {
    const overridden = build({ CHANNEL_CTA_ROUTES: 'PRICE_UPDATE=gold' });

    expect(
      overridden.decide({ messageType: 'PRICE_UPDATE', subjects: ['USD'] }),
    ).toEqual({ route: 'gold', labelFa: CTA_LABELS.gold });

    const silenced = build({ CHANNEL_CTA_ROUTES: 'PRICE_UPDATE=none' });

    expect(
      silenced.decide({
        messageType: 'PRICE_UPDATE',
        subjects: ['IR_GOLD_18K'],
      }),
    ).toBeNull();
  });

  it('still lets an explicit content choice outrank the configured override', () => {
    const policy = build({ CHANNEL_CTA_ROUTES: 'EDUCATIONAL=none' });

    expect(
      policy.decide({
        messageType: 'EDUCATIONAL',
        subjects: [],
        content: content({ ctaRoute: 'alert' }),
      }),
    ).toEqual({ route: 'alert', labelFa: CTA_LABELS.alert });
  });

  it('produces no CTA at all when the feature is switched off', () => {
    const policy = build({ CHANNEL_CTA_ENABLED: 'false' });

    expect(policy.enabled).toBe(false);
    expect(
      policy.decide({ messageType: 'PRICE_UPDATE', subjects: ['IR_GOLD_18K'] }),
    ).toBeNull();
    expect(
      policy.decide({ messageType: 'DAILY_REPORT', subjects: [] }),
    ).toBeNull();
    expect(
      policy.decide({
        messageType: 'EDUCATIONAL',
        subjects: [],
        content: content({ ctaRoute: 'alert' }),
      }),
    ).toBeNull();
  });

  it('describes the default policy in Persian for the admin surfaces', () => {
    const policy = build();

    expect(policy.describeDefault('EDUCATIONAL')).toContain('بدون دکمه');
    expect(policy.describeDefault('PRICE_UPDATE')).toContain('گروه نمادها');
    expect(policy.describeDefault('DAILY_REPORT')).toContain(CTA_LABELS.prices);
  });

  it('never returns a label without a route, and every label describes its route', () => {
    const policy = build();
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
      const decision = policy.decide({
        messageType,
        subjects: ['IR_GOLD_18K'],
      });

      if (decision) {
        expect(decision.labelFa).toBe(CTA_LABELS[decision.route]);
        expect(decision.labelFa.length).toBeGreaterThan(0);
      }
    }
  });

  it('is pure: deciding does not mutate the content item it is given', () => {
    const item = content({ ctaRoute: 'alert' });
    const snapshot = JSON.stringify(item);

    build().decide({
      messageType: item.messageType,
      subjects: [],
      content: item,
    });

    expect(JSON.stringify(item)).toBe(snapshot);
  });

  it('logs the resolved policy without any secret', () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    build({ BALE_BOT_TOKEN: '123456:SHOULD-NEVER-LOG' }).logPolicy();

    const line = String(log.mock.calls[0]?.[0] ?? '');

    expect(line).toContain('Channel CTAs: enabled');
    expect(line).toContain('PRICE_UPDATE');
    expect(line).not.toContain('SHOULD-NEVER-LOG');
    expect(line).not.toContain('123456');

    log.mockRestore();
  });
});
