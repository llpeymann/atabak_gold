import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AlertService } from '../../alerts/alert.service';
import { AlertStore } from '../../alerts/alert.store';
import { BotUxService } from './bot-ux.service';
import {
  callbackDataForFavorite,
  callbackDataForManageFavorites,
  callbackDataForScreen,
} from './callback-data';
import { MarketViewService } from './market-view.service';
import { UxEventLogService } from './ux-event-log.service';
import { AppConfigService } from '../../config/app-config.service';
import { InboundCallback, InboundMessage } from '../../platform/platform.types';
import { UserService } from '../../users/user.service';
import { UserStore } from '../../users/user.store';
import {
  createAppConfigService,
  createMarketHarness,
  createPlatformHarness,
  keyboardButtons,
  MarketHarness,
  PlatformHarness,
  seedMarketState,
} from '../../testing/test-doubles';

const PLATFORM_USER = 'integration-user';
const CHAT_ID = 'integration-chat';

let updateId = 100;

const message = (
  text: string,
  platformUserId = PLATFORM_USER,
): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId,
  messageId: 200 + updateId,
  text,
});

const callback = (
  data: string,
  platformUserId = PLATFORM_USER,
): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId,
  messageId: 999,
  callbackId: `cb-${updateId}`,
  data,
});

interface Stack {
  botUx: BotUxService;
  store: UserStore;
  users: UserService;
  platform: PlatformHarness;
  market: MarketHarness;
  config: AppConfigService;
}

/**
 * Phase 2 §54 — favorites must survive a restart.
 *
 * The flow runs through the real user store backed by a real file, with the real router and the
 * real platform adapters. A "restart" builds a brand new object graph over the same file,
 * exactly like a new process would.
 */
describe('favorites flow (integration)', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'atabak-favorites-'));
    filePath = join(directory, 'users.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** Real store + real router + real adapters; only the market provider is absent. */
  const createStack = async (): Promise<Stack> => {
    const env = { USER_DATA_FILE: filePath };
    const config = createAppConfigService(env);
    const platform = createPlatformHarness(env);
    const market = createMarketHarness(env);
    const store = new UserStore(config);
    await store.ensureLoaded();

    const users = new UserService(config, store);
    const views = new MarketViewService(config, market.marketState, users);
    const alertStore = new AlertStore(config);
    const alerts = new AlertService(
      config,
      alertStore,
      market.marketState,
      store,
    );
    const botUx = new BotUxService(
      config,
      platform.registry,
      views,
      users,
      new UxEventLogService(),
      alerts,
    );

    return { botUx, store, users, platform, market, config };
  };

  const lastText = (stack: Stack): string =>
    stack.platform.calls.at(-1)?.text ?? '';

  it('keeps favorites after a restart and renders them from market state', async () => {
    // --- first session --------------------------------------------------------
    const first = await createStack();
    await seedMarketState(first.market);

    await first.botUx.handleUpdate(message('/start'));
    await first.botUx.handleUpdate(
      callback(callbackDataForScreen('favorites')),
    );
    expect(lastText(first)).toContain(
      'هنوز موردی به علاقهمندیها اضافه نکردهاید.',
    );

    await first.botUx.handleUpdate(
      callback(callbackDataForFavorite('add', 'IR_GOLD_18K')),
    );
    await first.botUx.handleUpdate(
      callback(callbackDataForFavorite('add', 'USD')),
    );

    const userId = (await first.users.resolveUser('bale', PLATFORM_USER)).id;
    expect(first.users.listFavoriteSymbols(userId)).toEqual([
      'IR_GOLD_18K',
      'USD',
    ]);

    // --- restart --------------------------------------------------------------
    const second = await createStack();
    await seedMarketState(second.market);

    // Favorites come back from disk…
    expect(second.users.listFavoriteSymbols(userId)).toEqual([
      'IR_GOLD_18K',
      'USD',
    ]);

    // …and the UI renders them with live, validated prices (2 of 10 selected).
    await second.botUx.handleUpdate(
      callback(callbackDataForScreen('favorites')),
    );

    const text = lastText(second);
    expect(text).toContain('⭐ <b>علاقهمندیهای من</b>');
    expect(text).toContain('طلای ۱۸ عیار');
    expect(text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
    expect(text).toContain('دلار آمریکا');
    expect(text).toContain('📌 ۲ از ۱۰ مورد انتخاب شده است.');
  });

  it('keeps restored favorites selected in the management screen', async () => {
    const first = await createStack();
    await first.botUx.handleUpdate(
      callback(callbackDataForFavorite('add', 'IR_COIN_EMAMI')),
    );

    const second = await createStack();
    await second.botUx.handleUpdate(callback(callbackDataForManageFavorites()));

    const buttons = keyboardButtons(second.platform.calls.at(-1)!);
    const coin = buttons.find((button) => button.text.includes('سکه امامی'));
    const gold = buttons.find((button) => button.text.includes('طلای ۱۸ عیار'));

    expect(coin?.text.startsWith('☑')).toBe(true);
    expect(coin?.callbackData).toBe('v1:fav:remove:IR_COIN_EMAMI');
    expect(gold?.text.startsWith('☐')).toBe(true);
    expect(gold?.callbackData).toBe('v1:fav:add:IR_GOLD_18K');
  });

  it('keeps users apart across a restart (isolation survives persistence)', async () => {
    const first = await createStack();
    await first.botUx.handleUpdate(message('/start', 'user-a'));
    await first.botUx.handleUpdate(message('/start', 'user-b'));
    await first.botUx.handleUpdate(
      callback(callbackDataForFavorite('add', 'USD'), 'user-a'),
    );

    const second = await createStack();
    const userA = (await second.users.resolveUser('bale', 'user-a')).id;
    const userB = (await second.users.resolveUser('bale', 'user-b')).id;

    expect(second.users.listFavoriteSymbols(userA)).toEqual(['USD']);
    expect(second.users.listFavoriteSymbols(userB)).toEqual([]);

    await second.botUx.handleUpdate(
      callback(callbackDataForScreen('favorites'), 'user-b'),
    );

    expect(lastText(second)).toContain(
      'هنوز موردی به علاقهمندیها اضافه نکردهاید.',
    );
  });

  it('persists a store file with the documented shape', async () => {
    const stack = await createStack();
    await stack.botUx.handleUpdate(message('/start'));
    await stack.botUx.handleUpdate(
      callback(callbackDataForFavorite('add', 'EUR')),
    );

    const persisted = JSON.parse(await readFile(filePath, 'utf-8')) as {
      version: number;
      users: Record<string, unknown>[];
      favorites: Record<string, unknown>[];
    };

    expect(persisted.version).toBe(1);
    expect(persisted.users).toHaveLength(1);
    expect(Object.keys(persisted.users[0] ?? {}).sort()).toEqual([
      'chatId',
      'createdAt',
      'id',
      'platform',
      'platformUserId',
      'updatedAt',
    ]);
    expect(persisted.favorites[0]).toMatchObject({ symbol: 'EUR' });
  });
});
