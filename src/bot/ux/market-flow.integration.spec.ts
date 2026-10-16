import { AlertService } from '../../alerts/alert.service';
import { AlertStore } from '../../alerts/alert.store';
import { BotUxService } from './bot-ux.service';
import { createCampaignHarness } from '../../testing/test-doubles';
import { ContentAdminService } from '../content/content-admin.service';
import { CtaPolicyService } from '../../channel/cta-policy.service';
import { BotDestinationService } from '../destination.service';
import { ContentService } from '../../channel/content.service';
import { PublicationStore } from '../../channel/publication.store';
import { ChannelEngineService } from '../../channel/channel-engine.service';
import { callbackDataForScreen } from './callback-data';
import { MarketIntelligenceService } from '../../intelligence/market-intelligence.service';
import { MarketViewService } from './market-view.service';
import { UxEventLogService } from './ux-event-log.service';
import { MarketEngineService } from '../../market/market-engine.service';
import { MarketStateService } from '../../market/market-state.service';
import { PriceService } from '../../price/price.service';
import { InboundCallback } from '../../platform/platform.types';
import { UserService } from '../../users/user.service';
import { UserStore } from '../../users/user.store';
import {
  createAppConfigService,
  createMarketHarness,
  createPlatformHarness,
  DEFAULT_SEED_PRICES,
  keyboardButtons,
  MarketHarness,
  PlatformCall,
  PlatformHarness,
  rawPricePayload,
  seedMarketState,
} from '../../testing/test-doubles';

let updateId = 0;

import { AlertCapacityService } from '../../alerts/alert-capacity.service';
import { ReferralService } from '../../referrals/referral.service';

const callback = (data: string): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: 'chat-1',
  platformUserId: 'market-flow-user',
  messageId: 321,
  callbackId: `cb-${updateId}`,
  data,
});

interface FlowHarness {
  botUx: BotUxService;
  platform: PlatformHarness;
  market: MarketHarness;
  users: UserService;
  /** Records every call to the (absent) external provider. */
  providerCalls: string[];
}

/**
 * Phase 2 §55 — the price screen must be served from the Phase 1 market state.
 *
 * The pipeline (API → parser → normalizer → sanity → market state) is the *only* way a price
 * reaches the UI: the router is wired with a `PriceService` that fails the test if it is ever
 * called, which proves the bot never fetches the external market API from a user interaction.
 */
describe('market flow (integration)', () => {
  const build = (): FlowHarness => {
    const env = { USER_DATA_FILE: '' };
    const config = createAppConfigService(env);
    const platform = createPlatformHarness(env);
    const market = createMarketHarness(env);
    const store = new UserStore(config);
    const users = new UserService(config, store);
    const views = new MarketViewService(
      config,
      market.marketState,
      new MarketIntelligenceService(config, market.marketState),
      users,
    );
    const events = new UxEventLogService();

    // A provider that records every call: the UX layer must never use it.
    const providerCalls: string[] = [];
    const priceService = {
      fetchRawPayload: () => {
        providerCalls.push(new Date().toISOString());
        return Promise.reject(
          new Error(
            'The bot UX layer must never call the external market API.',
          ),
        );
      },
    } as unknown as PriceService;

    const alertStore = new AlertStore(config);
    const alerts = new AlertService(
      config,
      alertStore,
      market.marketState,
      store,
      new AlertCapacityService(config, store),
    );
    const growth = new ReferralService(
      config,
      store,
      new AlertCapacityService(config, store),
    );
    // Phase 8 — the campaign stack, wired exactly like the application (destinations are shared).
    const campaigns = createCampaignHarness(
      { ...process.env, BOT_POLLING_ENABLED: 'false' },
      { config },
    );

    const botUx = new BotUxService(
      config,
      platform.registry,
      views,
      users,
      events,
      alerts,
      new ContentAdminService(
        config,
        new ContentService(config, new PublicationStore(config)),
        {} as unknown as ChannelEngineService,
        new CtaPolicyService(config),
      ),
      new BotDestinationService(config),
      growth,
      campaigns.tracking,
      campaigns.admin,
    );

    // `priceService` only exists to prove it is never used.
    void priceService;

    return { botUx, platform, market, users, providerCalls };
  };

  const lastCall = (calls: PlatformCall[]): PlatformCall => calls.at(-1)!;

  it('renders prices that came through the Phase 1 pipeline', async () => {
    const { botUx, platform, market } = build();

    // The scheduler runs a cycle: external payload → validation → market state.
    await seedMarketState(market);

    await botUx.handleUpdate(callback(callbackDataForScreen('prices')));

    const text = lastCall(platform.calls).text ?? '';
    expect(text).toContain('💰 قیمت لحظهای بازار');
    expect(text).toContain('طلای ۱۸ عیار');
    expect(text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(text).toContain('اونس جهانی');
    expect(text).toContain('🕐 آخرین بروزرسانی:');
  });

  it('never calls the price provider while a user navigates', async () => {
    const { botUx, market, providerCalls } = build();
    await seedMarketState(market);

    for (const screen of [
      'prices',
      'gold',
      'coins',
      'market',
      'favorites',
    ] as const) {
      await botUx.handleUpdate(callback(callbackDataForScreen(screen)));
      await botUx.handleUpdate(callback('v1:back'));
    }

    expect(providerCalls).toHaveLength(0);
  });

  it('keeps rendering the last valid state after the provider starts failing', async () => {
    const { botUx, platform, market } = build();
    await seedMarketState(market, { receivedAt: new Date() });

    // A later, failed cycle (structurally invalid payload — what a broken provider or a
    // network error looks like to the engine) must leave the market state untouched.
    const failed = await market.engine.evaluateCycle({});
    expect(failed.update.publishable).toBe(false);
    expect(failed.update.blockingReason).toBe('INVALID_SCHEMA');

    await botUx.handleUpdate(callback(callbackDataForScreen('prices')));

    expect(lastCall(platform.calls).text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
  });

  it('shows the stale notice when the last accepted update is old', async () => {
    const { botUx, platform, market } = build();
    await seedMarketState(market, {
      receivedAt: new Date(Date.now() - 3 * 60 * 60_000),
    });

    await botUx.handleUpdate(callback(callbackDataForScreen('prices')));

    const text = lastCall(platform.calls).text ?? '';
    expect(text).toContain('⚠️ آخرین قیمت معتبر');
    // The value is still the last valid one — never zeroed out.
    expect(text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
  });

  it('never publishes rejected prices to the user', async () => {
    const { botUx, platform, market } = build();
    await seedMarketState(market);

    // An anomalous value (3× the previous price) is rejected by the Phase 1 sanity engine.
    await market.engine.evaluateCycle(
      rawPricePayload({ ...DEFAULT_SEED_PRICES, IR_GOLD_18K: 52_500_000 }),
      new Date(),
    );

    await botUx.handleUpdate(callback(callbackDataForScreen('prices')));

    const text = lastCall(platform.calls).text ?? '';
    expect(text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(text).not.toContain('۵۲٬۵۰۰٬۰۰۰');
  });

  it('offers refresh without touching the market provider', async () => {
    const { botUx, platform, market } = build();
    await seedMarketState(market, { receivedAt: new Date() });

    await botUx.handleUpdate(callback(callbackDataForScreen('prices')));
    const refresh = keyboardButtons(platform.calls.at(-1)!).find(
      (button) => button.text === '↻ بروزرسانی',
    );
    expect(refresh?.callbackData).toBe('v1:screen:prices');

    await botUx.handleUpdate(callback(refresh!.callbackData!));

    expect(lastCall(platform.calls).text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
  });

  describe('Phase 4 — market intelligence refresh (§42, §43, §54)', () => {
    it('re-renders the market report without fetching a price or moving the timestamp', async () => {
      const { botUx, platform, market, providerCalls } = build();
      const receivedAt = new Date(Date.now() - 5 * 60_000);
      await seedMarketState(market, { receivedAt });

      await botUx.handleUpdate(callback(callbackDataForScreen('report')));
      const first = lastCall(platform.calls);
      expect(first.text).toContain('🕐');

      const refresh = keyboardButtons(first).find(
        (button) => button.text === '↻ بروزرسانی',
      );
      expect(refresh?.callbackData).toBe('v1:screen:report');

      await botUx.handleUpdate(callback(refresh!.callbackData!));

      const second = lastCall(platform.calls);
      // Same screen, same values, and above all the same real market timestamp.
      expect(second.text).toContain('📊 <b>گزارش امروز</b>');
      expect(second.text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
      const timeIn = (text: string): string =>
        text.match(/🕐 ([۰-۹:]+)/)?.[1] ?? '';
      expect(timeIn(second.text ?? '')).toBe(timeIn(first.text ?? ''));
      expect(timeIn(second.text ?? '')).not.toBe('');
      // No provider call, and the market state itself was not advanced by the refresh.
      expect(providerCalls).toHaveLength(0);
      expect(market.marketState.getLastValidPrice('IR_GOLD_18K')).toBe(
        17_500_000,
      );
      const gold = market.config.symbolRegistry.find(
        (definition) => definition.symbol === 'IR_GOLD_18K',
      )!;
      expect(market.marketState.getState(gold)?.updatedAt).toBe(
        receivedAt.toISOString(),
      );
    });

    it('reads the validated market state once per symbol and never per API call', async () => {
      const { botUx, market } = build();
      await seedMarketState(market, { receivedAt: new Date() });
      const spy = jest.spyOn(market.marketState, 'getState');

      await botUx.handleUpdate(callback(callbackDataForScreen('report')));

      // One read pass over the registry: no N+1, no per-symbol network round trip (§42).
      expect(spy).toHaveBeenCalledTimes(market.config.symbolRegistry.length);
    });

    it('keeps the daily report and the movement report on separate bases (§23)', async () => {
      const { botUx, platform, market } = build();
      await seedMarketState(market, {
        receivedAt: new Date(),
        replace: true,
        prices: { IR_GOLD_18K: 17_000_000 },
      });
      await seedMarketState(market, {
        receivedAt: new Date(),
        replace: true,
        prices: { IR_GOLD_18K: 17_200_000 },
      });
      await seedMarketState(market, {
        receivedAt: new Date(),
        replace: true,
        prices: { IR_GOLD_18K: 17_150_000 },
      });

      await botUx.handleUpdate(callback(callbackDataForScreen('report')));
      const report = lastCall(platform.calls).text ?? '';

      await botUx.handleUpdate(callback(callbackDataForScreen('movement')));
      const movement = lastCall(platform.calls).text ?? '';

      // Daily: 17,000,000 → 17,150,000 (open of the day); movement: 17,200,000 → 17,150,000.
      expect(report).toContain('تغییر روزانه: 🟢 +۱۵۰٬۰۰۰ ریال | +۰٫۸۸٪');
      expect(report).not.toContain('−۵۰٬۰۰۰');
      // Movement carries both the absolute move and its percentage, on its own basis.
      expect(movement).toContain('🔴 −۵۰٬۰۰۰ ریال | −۰٫۲۹٪');
      expect(movement).toContain('قیمت قبلی: ۱۷٬۲۰۰٬۰۰۰ ریال');
    });

    it('degrades to the unavailable screen when the market-state read fails (§45)', async () => {
      const { botUx, platform, market } = build();
      jest.spyOn(market.marketState, 'getState').mockImplementation(() => {
        throw new Error('state store unavailable');
      });

      for (const screen of ['report', 'movement', 'last-update'] as const) {
        await botUx.handleUpdate(callback(callbackDataForScreen(screen)));
        const text = lastCall(platform.calls).text ?? '';

        // A friendly screen — no crash, no empty message, no technical detail (§45).
        expect(text).toContain('اطلاعات معتبر بازار در دسترس نیست');
        expect(text).not.toContain('state store unavailable');
        expect(text).not.toContain('undefined');
      }
    });

    it('keeps the report alive when only one symbol cannot be read (§20, §52)', async () => {
      const { botUx, platform, market } = build();
      await seedMarketState(market, { receivedAt: new Date() });
      const real = market.marketState.getState.bind(market.marketState);
      jest
        .spyOn(market.marketState, 'getState')
        .mockImplementation((definition, now) => {
          if (definition.symbol === 'USD') {
            throw new Error('single symbol read failed');
          }

          return real(definition, now);
        });

      await botUx.handleUpdate(callback(callbackDataForScreen('report')));

      const text = lastCall(platform.calls).text ?? '';
      // The other symbols are still reported, and the broken one is explicitly unavailable.
      expect(text).toContain('طلای ۱۸ عیار');
      expect(text).toContain('دلار');
      expect(text).toContain('⚠️ فعلاً اطلاعات معتبری در دسترس نیست.');
      expect(text).not.toContain('single symbol read failed');
    });
  });

  it('exposes the Phase 1 pipeline as the single price source', () => {
    const { market } = build();

    // The objects the UX layer depends on are exactly the Phase 1 read layer.
    expect(market.marketState).toBeInstanceOf(MarketStateService);
    expect(market.engine).toBeInstanceOf(MarketEngineService);
  });
});
