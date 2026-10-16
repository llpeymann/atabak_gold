import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UserStore } from './user.store';
import { createAppConfigService } from '../testing/test-doubles';

describe('UserStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'atabak-users-'));
    filePath = join(directory, 'users.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const createStore = (): UserStore =>
    new UserStore(createAppConfigService({ USER_DATA_FILE: filePath }));

  it('persists users and favorites to disk atomically', async () => {
    const store = createStore();
    const user = await store.upsertUser('bale-1', 'bale');

    await store.addFavorite(user.id, 'IR_GOLD_18K');

    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      users: { platformUserId: string }[];
      favorites: { symbol: string }[];
    };

    expect(parsed.users).toHaveLength(1);
    expect(parsed.users[0]?.platformUserId).toBe('bale-1');
    expect(parsed.favorites.map((favorite) => favorite.symbol)).toEqual([
      'IR_GOLD_18K',
    ]);
  });

  it('restores users and favorites after a restart', async () => {
    const first = createStore();
    const user = await first.upsertUser('bale-1', 'bale');
    await first.addFavorite(user.id, 'IR_GOLD_18K');
    await first.addFavorite(user.id, 'USD');

    const second = createStore();
    await second.load();

    const restored = second.listUsers();
    expect(restored).toHaveLength(1);
    expect(
      second
        .listFavorites(restored[0].id)
        .map((f) => f.symbol)
        .sort(),
    ).toEqual(['IR_GOLD_18K', 'USD']);
  });

  it('never stores the same (user, symbol) pair twice', async () => {
    const store = createStore();
    const user = await store.upsertUser('bale-1', 'bale');

    await Promise.all([
      store.addFavorite(user.id, 'USD'),
      store.addFavorite(user.id, 'USD'),
      store.addFavorite(user.id, 'USD'),
    ]);

    expect(store.listFavorites(user.id)).toHaveLength(1);
    expect(store.favoriteCount).toBe(1);
  });

  it('serializes concurrent writes so no update is lost', async () => {
    const store = createStore();
    const user = await store.upsertUser('bale-1', 'bale');

    await Promise.all([
      store.addFavorite(user.id, 'USD'),
      store.addFavorite(user.id, 'EUR'),
      store.addFavorite(user.id, 'GBP'),
      store.removeFavorite(user.id, 'USD'),
    ]);

    const reloaded = createStore();
    await reloaded.load();

    expect(
      reloaded
        .listFavorites(user.id)
        .map((favorite) => favorite.symbol)
        .sort(),
    ).toEqual(['EUR', 'GBP']);
  });

  it('keeps favorites isolated per user', async () => {
    const store = createStore();
    const first = await store.upsertUser('bale-1', 'bale');
    const second = await store.upsertUser('bale-2', 'bale');

    await store.addFavorite(first.id, 'USD');
    await store.addFavorite(second.id, 'IR_COIN_EMAMI');

    expect(store.listFavorites(first.id).map((f) => f.symbol)).toEqual(['USD']);
    expect(store.listFavorites(second.id).map((f) => f.symbol)).toEqual([
      'IR_COIN_EMAMI',
    ]);
  });

  it('recognizes the same platform identity instead of creating a second user', async () => {
    const store = createStore();

    const first = await store.upsertUser('bale-1', 'bale');
    const again = await store.upsertUser('bale-1', 'bale');

    expect(again.id).toBe(first.id);
    expect(store.listUsers()).toHaveLength(1);
  });

  it('keeps the same platform id on different platforms apart', async () => {
    const store = createStore();

    const onBale = await store.upsertUser('42', 'bale');
    const onTelegram = await store.upsertUser('42', 'telegram');

    expect(onBale.id).not.toBe(onTelegram.id);
    expect(store.listUsers()).toHaveLength(2);
  });

  it('starts empty when the persisted file is corrupt instead of crashing', async () => {
    await writeFile(filePath, '{ this is not json', 'utf-8');

    const store = createStore();
    await store.load();

    expect(store.listUsers()).toHaveLength(0);
    expect(store.favoriteCount).toBe(0);
  });

  it('starts empty when the persisted file has an unexpected shape', async () => {
    await writeFile(filePath, JSON.stringify({ users: 'nope' }), 'utf-8');

    const store = createStore();
    await store.load();

    expect(store.listUsers()).toHaveLength(0);
  });

  it('loads a document written before Phase 7 and upgrades it without losing data (§14)', async () => {
    // A representative pre-Phase-7 document: no `version`, no `referrals`, no `rewards`, and users
    // without the Phase 7 fields. Deploying Phase 7 must preserve every one of these records.
    await writeFile(
      filePath,
      JSON.stringify({
        savedAt: '2026-10-01T00:00:00.000Z',
        users: [
          {
            id: 'usr_legacy_1',
            platform: 'bale',
            platformUserId: '9001',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        ],
        favorites: [
          {
            id: 'fav_legacy_1',
            userId: 'usr_legacy_1',
            symbol: 'IR_GOLD_18K',
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      }),
      'utf-8',
    );

    const store = createStore();
    await store.load();

    const [user] = store.listUsers();

    expect(user.id).toBe('usr_legacy_1');
    // Missing Phase 3/Phase 7 fields are normalized, never invented (a missing chat id is not the id,
    // a missing interaction timestamp is "no interaction" — the active-member metric reads inactive).
    expect(user.chatId).toBeNull();
    expect(user.lastInteractionAt).toBeNull();
    expect(user.referralCode ?? null).toBeNull();
    expect(store.listFavorites(user.id).map((f) => f.symbol)).toEqual([
      'IR_GOLD_18K',
    ]);
    expect(store.listReferrals()).toHaveLength(0);

    // The first write upgrades the document; the legacy record survives it.
    await store.upsertUser('9002', 'bale');

    const upgraded = JSON.parse(await readFile(filePath, 'utf-8')) as {
      version: number;
      users: { id: string }[];
      referrals: unknown[];
      rewards: unknown[];
    };

    expect(upgraded.version).toBe(2);
    expect(upgraded.users.map((row) => row.id)).toContain('usr_legacy_1');
    expect(upgraded.referrals).toEqual([]);
    expect(upgraded.rewards).toEqual([]);
  });

  it('runs in memory only when USER_DATA_FILE is empty', async () => {
    const store = new UserStore(createAppConfigService({ USER_DATA_FILE: '' }));

    expect(store.enabled).toBe(false);
    const user = await store.upsertUser('bale-1', 'bale');
    await store.addFavorite(user.id, 'USD');

    expect(store.listFavorites(user.id)).toHaveLength(1);
  });
});
