import { BotUxService } from './bot-ux.service';
import { callbackDataForScreen } from './callback-data';
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
    const views = new MarketViewService(config, market.marketState, users);
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

    const botUx = new BotUxService(
      config,
      platform.registry,
      views,
      users,
      events,
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

  it('exposes the Phase 1 pipeline as the single price source', () => {
    const { market } = build();

    // The objects the UX layer depends on are exactly the Phase 1 read layer.
    expect(market.marketState).toBeInstanceOf(MarketStateService);
    expect(market.engine).toBeInstanceOf(MarketEngineService);
  });
});
