import { UserService } from './user.service';
import { UserStore } from './user.store';
import { createAppConfigService } from '../testing/test-doubles';

const createService = (
  env: Record<string, string | undefined> = {},
): { service: UserService; store: UserStore } => {
  const config = createAppConfigService(env);
  const store = new UserStore(config);

  return { service: new UserService(config, store), store };
};

describe('UserService', () => {
  it('creates a user on first contact and reuses it afterwards', async () => {
    const { service } = createService();

    const first = await service.resolveUser('bale', 'platform-1');
    const second = await service.resolveUser('bale', 'platform-1');

    expect(second.id).toBe(first.id);
    expect(first.platform).toBe('bale');
    expect(first.platformUserId).toBe('platform-1');
  });

  it('adds a supported symbol to favorites', async () => {
    const { service } = createService();
    const user = await service.resolveUser('bale', 'platform-1');

    const result = await service.addFavorite(user.id, 'IR_GOLD_18K');

    expect(result).toMatchObject({ ok: true, action: 'added' });
    expect(service.listFavoriteSymbols(user.id)).toEqual(['IR_GOLD_18K']);
  });

  it('treats a repeated add as unchanged (no duplicate favorite)', async () => {
    const { service } = createService();
    const user = await service.resolveUser('bale', 'platform-1');

    await service.addFavorite(user.id, 'USD');
    const again = await service.addFavorite(user.id, 'USD');

    expect(again).toMatchObject({ ok: true, action: 'unchanged' });
    expect(service.listFavoriteSymbols(user.id)).toEqual(['USD']);
  });

  it('removes a favorite', async () => {
    const { service } = createService();
    const user = await service.resolveUser('bale', 'platform-1');
    await service.addFavorite(user.id, 'USD');

    const result = await service.removeFavorite(user.id, 'USD');

    expect(result).toMatchObject({ ok: true, action: 'removed' });
    expect(service.listFavoriteSymbols(user.id)).toEqual([]);
  });

  it('reports a removal of a symbol that was not a favorite', async () => {
    const { service } = createService();
    const user = await service.resolveUser('bale', 'platform-1');

    const result = await service.removeFavorite(user.id, 'USD');

    expect(result).toMatchObject({ ok: true, action: 'unchanged' });
  });

  it('rejects an unsupported symbol', async () => {
    const { service } = createService();
    const user = await service.resolveUser('bale', 'platform-1');

    const result = await service.addFavorite(user.id, 'NOT_A_SYMBOL');

    expect(result).toMatchObject({ ok: false, reason: 'UNKNOWN_SYMBOL' });
    expect(service.listFavoriteSymbols(user.id)).toEqual([]);
  });

  it('enforces the configurable limit instead of silently dropping the action', async () => {
    const { service } = createService({ MAX_FAVORITES: '2' });
    const user = await service.resolveUser('bale', 'platform-1');

    await service.addFavorite(user.id, 'USD');
    await service.addFavorite(user.id, 'EUR');
    const overflow = await service.addFavorite(user.id, 'GBP');

    expect(overflow).toEqual({ ok: false, reason: 'LIMIT_REACHED', limit: 2 });
    expect(service.listFavoriteSymbols(user.id)).toEqual(['USD', 'EUR']);
  });

  it('still allows removing a favorite once the limit is reached', async () => {
    const { service } = createService({ MAX_FAVORITES: '1' });
    const user = await service.resolveUser('bale', 'platform-1');
    await service.addFavorite(user.id, 'USD');

    await service.removeFavorite(user.id, 'USD');
    const afterRemoval = await service.addFavorite(user.id, 'EUR');

    expect(afterRemoval).toMatchObject({ ok: true, action: 'added' });
  });

  it('keeps favorites strictly per user', async () => {
    const { service } = createService();
    const first = await service.resolveUser('bale', 'platform-1');
    const second = await service.resolveUser('bale', 'platform-2');

    await service.addFavorite(first.id, 'IR_GOLD_18K');

    expect(service.listFavoriteSymbols(first.id)).toEqual(['IR_GOLD_18K']);
    expect(service.listFavoriteSymbols(second.id)).toEqual([]);
    expect(service.isFavorite(second.id, 'IR_GOLD_18K')).toBe(false);
  });

  it('refuses mutations for a user that does not exist', async () => {
    const { service } = createService();

    await expect(service.addFavorite('usr_missing', 'USD')).resolves.toEqual({
      ok: false,
      reason: 'USER_NOT_FOUND',
    });
  });

  it('never creates duplicate favorites under concurrent requests', async () => {
    const { service } = createService();
    const user = await service.resolveUser('bale', 'platform-1');

    await Promise.all([
      service.addFavorite(user.id, 'USD'),
      service.addFavorite(user.id, 'USD'),
      service.addFavorite(user.id, 'USD'),
    ]);

    expect(service.listFavoriteSymbols(user.id)).toEqual(['USD']);
  });

  it('validates symbols against the Phase 1 registry, not a local list', () => {
    const { service } = createService();

    expect(service.isSupportedSymbol('IR_COIN_EMAMI')).toBe(true);
    expect(service.isSupportedSymbol('ir_coin_emami')).toBe(false);
    expect(service.isSupportedSymbol('')).toBe(false);
  });

  it('exposes the configured maximum', () => {
    const { service } = createService({ MAX_FAVORITES: '4' });

    expect(service.maxFavorites).toBe(4);
  });
});
