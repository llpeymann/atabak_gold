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
  const views = new MarketViewService(config, market.marketState, users);
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

  it('builds the daily snapshot only from symbols with a daily window', async () => {
    const { market, views } = await createViews();
    await seedMarketState(market);

    const snapshot = views.buildMarketSnapshot(VIEW_NOW);

    expect(snapshot.lines.map((line) => line.symbol)).toEqual([
      'IR_GOLD_18K',
      'IR_COIN_EMAMI',
      'USD',
    ]);
    const gold = snapshot.lines[0];
    expect(gold?.open).toBe(17_500_000);
    expect(gold?.change).toBe(0);
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
