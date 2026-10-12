import { MarketIntelligenceService } from '../../intelligence/market-intelligence.service';
import { MarketViewService } from './market-view.service';
import {
  createMarketHarness,
  seedMarketState,
} from '../../testing/test-doubles';
import { UserService } from '../../users/user.service';
import { UserStore } from '../../users/user.store';

const SEEDED_AT = new Date('2026-09-30T09:00:00.000Z');
/** "Now" used by the view layer: close to the seed so freshness is deterministic. */
const VIEW_NOW = new Date('2026-09-30T09:05:00.000Z');

const createViews = async (env: Record<string, string | undefined> = {}) => {
  const market = createMarketHarness(env);
  const config = market.config;
  const users = new UserService(config, new UserStore(config));
  const views = new MarketViewService(
    config,
    market.marketState,
    new MarketIntelligenceService(config, market.marketState),
    users,
  );
  const user = await users.resolveUser('bale', 'view-user');

  return { market, views, users, user };
};

describe('MarketViewService', () => {
  it('returns nothing before any validated price exists (no fabrication)', async () => {
    const { views } = await createViews();

    const list = views.buildPriceList(['gold', 'coins', 'currency'], VIEW_NOW);

    expect(list.sections).toEqual([]);
    expect(list.lastUpdate).toBeNull();
    expect(list.missing.length).toBeGreaterThan(0);
  });

  it('projects validated state into price views', async () => {
    const { market, views } = await createViews();
    await seedMarketState(market);

    const list = views.buildPriceList(['gold'], VIEW_NOW);
    const gold = list.sections[0]?.items.find(
      (item) => item.symbol === 'IR_GOLD_18K',
    );

    expect(gold).toMatchObject({
      label: 'طلای ۱۸ عیار',
      price: 17_500_000,
      unit: 'RIAL',
      section: 'gold',
      freshness: 'FRESH',
    });
    expect(list.lastUpdate).toBe('2026-09-30T09:00:00.000Z');
  });

  it('groups sections in registry order', async () => {
    const { market, views } = await createViews();
    await seedMarketState(market);

    const list = views.buildPriceList(['gold', 'coins', 'currency'], VIEW_NOW);

    expect(list.sections.map((section) => section.section)).toEqual([
      'gold',
      'coins',
      'currency',
    ]);
    expect(list.sections[1]?.items[0]?.symbol).toBe('IR_COIN_EMAMI');
  });

  it('reports stale state instead of hiding it', async () => {
    const { market, views } = await createViews({
      PRICE_STALE_AFTER_MINUTES: '1',
    });
    await seedMarketState(market, { receivedAt: SEEDED_AT });

    const list = views.buildPriceList(
      ['gold'],
      new Date('2026-09-30T12:00:00.000Z'),
    );

    expect(list.hasStale).toBe(true);
    expect(list.sections[0]?.items[0]?.freshness).toBe('STALE');
  });

  it('lists missing symbols of the requested scope', async () => {
    const { market, views } = await createViews();
    await seedMarketState(market, {
      replace: true,
      prices: {
        IR_COIN_EMAMI: 92_000_000,
      },
    });

    const list = views.buildPriceList(['coins'], VIEW_NOW);

    expect(list.sections[0]?.items.map((item) => item.symbol)).toEqual([
      'IR_COIN_EMAMI',
    ]);
    expect(list.missing).toContain('نیم سکه');
  });

  it('builds the Phase 4 intelligence snapshot for every registry symbol', async () => {
    const { market, views } = await createViews();
    // Only two symbols are fed, so the snapshot has to deal with a partial market (§52).
    await seedMarketState(market, {
      receivedAt: new Date('2026-09-30T09:00:00.000Z'),
      replace: true,
      prices: { IR_GOLD_18K: 17_500_000, IR_COIN_EMAMI: 92_000_000 },
    });

    const snapshot = views.buildIntelligence(VIEW_NOW);
    const bySymbol = new Map(
      snapshot.symbols.map((symbol) => [symbol.symbol, symbol]),
    );

    // Symbols with validated data carry their daily window …
    expect(bySymbol.get('IR_GOLD_18K')?.open).toBe(17_500_000);
    expect(bySymbol.get('IR_GOLD_18K')?.dailyChange).toBe(0);
    expect(bySymbol.get('IR_COIN_EMAMI')?.availability).toBe('AVAILABLE');
    // … and the rest are listed explicitly as unavailable instead of being dropped (§19, §20).
    expect(bySymbol.get('TRY')?.availability).toBe('UNAVAILABLE');
    expect(bySymbol.get('TRY')?.currentPrice).toBeNull();
    expect(snapshot.symbols).toHaveLength(market.config.symbolRegistry.length);
    expect(snapshot.summary.available).toBe(2);
  });

  it('projects a single symbol through the same read-only builder', async () => {
    const { market, views } = await createViews();
    await seedMarketState(market);

    const gold = views.buildSymbolIntelligence('IR_GOLD_18K', VIEW_NOW);

    expect(gold?.symbol).toBe('IR_GOLD_18K');
    expect(gold?.currentPrice).toBe(17_500_000);
    expect(views.buildSymbolIntelligence('NOT_A_SYMBOL', VIEW_NOW)).toBeNull();
  });

  it('builds favorites views for an explicit symbol list only', async () => {
    const { market, views, users, user } = await createViews();
    await seedMarketState(market);
    await users.addFavorite(user.id, 'EUR');

    const list = views.buildPriceListForSymbols(
      users.listFavoriteSymbols(user.id),
      VIEW_NOW,
    );

    expect(list.sections).toHaveLength(1);
    expect(list.sections[0]?.items.map((item) => item.symbol)).toEqual(['EUR']);
  });

  it('builds management options from the canonical registry', async () => {
    const { users, views, user } = await createViews({ MAX_FAVORITES: '3' });
    await users.addFavorite(user.id, 'IR_GOLD_18K');

    const manage = views.buildFavoritesManage(user.id);

    expect(manage.options).toHaveLength(16);
    expect(
      manage.options.find((option) => option.symbol === 'IR_GOLD_18K')
        ?.selected,
    ).toBe(true);
    expect(manage.limit).toBe(3);
    expect(manage.selectedCount).toBe(1);
    expect(manage.limitReached).toBe(false);
  });
});
