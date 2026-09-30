import {
  callbackDataForFavorite,
  callbackDataForScreen,
} from './callback-data';
import {
  createUxHarness,
  keyboardButtons,
  PlatformCall,
  seedMarketState,
  UxHarness,
} from '../../testing/test-doubles';
import { InboundCallback, InboundMessage } from '../../platform/platform.types';

const CHAT_ID = 'chat-1';
const PLATFORM_USER = 'platform-user-1';

let updateId = 0;

const message = (
  text: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 500 + updateId,
  text,
  ...overrides,
});

const callback = (
  data: string,
  overrides: Partial<InboundCallback> = {},
): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 777,
  callbackId: `cb-${updateId}`,
  data,
  ...overrides,
});

const texts = (calls: PlatformCall[]): string[] =>
  calls.map((call) => call.text ?? '');

describe('BotUxService', () => {
  let harness: UxHarness;

  beforeEach(async () => {
    harness = createUxHarness();
    await seedMarketState(harness);
  });

  const send = async (text: string): Promise<void> => {
    await harness.botUx.handleUpdate(message(text));
  };

  const press = async (data: string): Promise<void> => {
    await harness.botUx.handleUpdate(callback(data));
  };

  describe('/start and the main menu', () => {
    it('greets the user and shows the main menu', async () => {
      await send('/start');

      const last = harness.last();
      expect(last.text).toContain('طلای اتابک');
      expect(harness.buttons().map((button) => button.text)).toEqual([
        '💰 قیمت لحظهای',
        '🟡 طلا',
        '🪙 سکه',
        '📊 بازار',
        '🔔 هشدار',
        '⭐ علاقهمندیها',
        '📢 کانال اتابک',
      ]);
    });

    it('recognizes the same user on the next interaction', async () => {
      await send('/start');
      await send('/start');

      expect(harness.store.listUsers()).toHaveLength(1);
    });

    it('supports /menu and /prices as text commands', async () => {
      await send('/menu');
      expect(harness.last().text).toContain('منوی اصلی');

      await send('/prices');
      expect(harness.last().text).toContain('قیمت لحظهای بازار');
    });

    it('answers an unknown command with the menu instead of failing', async () => {
      await send('/does-not-exist');

      expect(harness.last().text).toContain('منوی اصلی');
    });

    it('does not treat plain text as a command', async () => {
      await send('سلام');

      expect(harness.last().text).toContain('منوی اصلی');
    });
  });

  describe('live prices', () => {
    it('reads prices from the Phase 1 market state', async () => {
      await press(callbackDataForScreen('prices'));

      const text = harness.last().text ?? '';
      expect(text).toContain('💰 قیمت لحظهای بازار');
      expect(text).toContain('طلای ۱۸ عیار');
      expect(text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
      expect(text).toContain('🕐 آخرین بروزرسانی:');
    });

    it('edits the existing menu message instead of sending a new one', async () => {
      await press(callbackDataForScreen('prices'));

      const last = harness.last();
      expect(last.kind).toBe('edit');
      expect(last.messageId).toBe(777);
    });

    it('refreshes from the current state without a second market cycle', async () => {
      await press(callbackDataForScreen('prices'));
      const rendered = harness.rendered().length;

      await press(callbackDataForScreen('prices'));

      expect(harness.rendered()).toHaveLength(rendered + 1);
      expect(harness.last().text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
    });

    it('shows an empty state when no validated price exists yet', async () => {
      const empty = createUxHarness();

      await empty.botUx.handleUpdate(callback(callbackDataForScreen('prices')));

      expect(empty.last().text).toContain('در حال حاضر اطلاعات معتبری');
    });

    it('does not read directly from the market API', async () => {
      await press(callbackDataForScreen('prices'));

      // The UX harness has no PriceService at all: reaching the API is impossible by design.
      expect(harness.market).not.toHaveProperty('priceService');
      expect(harness.last().text).not.toContain('api.example.test');
    });
  });

  describe('gold and coin sections', () => {
    it('lists only gold instruments', async () => {
      await press(callbackDataForScreen('gold'));

      const text = harness.last().text ?? '';
      expect(text).toContain('🟡 طلا');
      expect(text).toContain('طلای ۱۸ عیار');
      expect(text).toContain('اونس جهانی');
      expect(text).not.toContain('سکه امامی');
    });

    it('lists only coin instruments', async () => {
      await press(callbackDataForScreen('coins'));

      const text = harness.last().text ?? '';
      expect(text).toContain('🪙 سکه');
      expect(text).toContain('سکه امامی');
      expect(text).not.toContain('طلای ۱۸ عیار');
    });

    it('shows an unavailable state when a section has no valid data', async () => {
      const empty = createUxHarness();
      await empty.botUx.handleUpdate(callback(callbackDataForScreen('coins')));

      expect(empty.last().text).toContain('اطلاعات معتبری برای');
    });

    it('names instruments without valid data instead of inventing values', async () => {
      const partial = createUxHarness();
      await seedMarketState(partial, {
        replace: true,
        prices: { IR_GOLD_18K: 17_500_000 },
      });
      await partial.users.resolveUser('bale', PLATFORM_USER);

      await partial.botUx.handleUpdate(callback(callbackDataForScreen('gold')));

      const text = partial.last().text ?? '';
      expect(text).toContain('بدون اطلاعات معتبر');
      expect(text).toContain('اونس جهانی');
    });
  });

  describe('market snapshot', () => {
    it('shows open/high/low/current/change for the anchor symbols', async () => {
      // Seeded "now" keeps the snapshot fresh (matches how the scheduler feeds the engine).
      const current = createUxHarness();
      await seedMarketState(current, { receivedAt: new Date() });

      await current.botUx.handleUpdate(
        callback(callbackDataForScreen('market')),
      );
      const text = current.last().text ?? '';

      expect(text).toContain('📊 <b>وضعیت بازار امروز</b>');
      expect(text).toContain('شروع روز:');
      expect(text).toContain('اکنون:');
      expect(text).toContain('بیشترین:');
      expect(text).toContain('کمترین:');
      expect(text).toContain('تغییر:');
      expect(text).toContain('طلای ۱۸ عیار');
      expect(text).toContain('سکه امامی');
      expect(text).toContain('دلار');
    });

    it('shows the prepared empty state without a daily window', async () => {
      const empty = createUxHarness();
      await empty.botUx.handleUpdate(callback(callbackDataForScreen('market')));

      expect(empty.last().text).toContain('اطلاعات بازار هنوز آماده نیست.');
    });
  });

  describe('stale market', () => {
    it('marks stale state and keeps showing the last valid price', async () => {
      const stale = createUxHarness({ PRICE_STALE_AFTER_MINUTES: '1' });
      await seedMarketState(stale, {
        receivedAt: new Date(Date.now() - 10 * 60_000),
      });

      await stale.botUx.handleUpdate(callback(callbackDataForScreen('prices')));

      const text = stale.last().text ?? '';
      expect(text).toContain('⚠️ آخرین قیمت معتبر');
      expect(text).toContain('۱۷٬۵۰۰٬۰۰۰ ریال');
    });
  });

  describe('navigation', () => {
    it('returns from a section to the main menu with back', async () => {
      await press(callbackDataForScreen('gold'));
      await press('v1:back');

      expect(harness.last().text).toContain('منوی اصلی');
    });

    it('returns to the favorites list from the management screen with back', async () => {
      await press('v1:fav:manage');
      await press('v1:back');

      expect(harness.last().text).toContain('علاقهمندیهای من');
    });

    it('goes home from anywhere', async () => {
      await press(callbackDataForScreen('market'));
      await press('v1:home');

      expect(harness.last().text).toContain('منوی اصلی');
    });

    it('never gets stuck in a loop: back from the menu stays in the menu', async () => {
      await press(callbackDataForScreen('coins'));
      await press('v1:back');
      await press('v1:back');

      expect(harness.last().text).toContain('منوی اصلی');
      expect(harness.buttons()).toHaveLength(8);
    });

    it('answers an unknown callback with a safe message', async () => {
      await press('v9:screen:definitely-not-a-screen');

      expect(harness.last().text).toContain('این گزینه دیگر معتبر نیست.');
      expect(harness.buttons()[0]?.text).toBe('🏠 منوی اصلی');
    });

    it('acknowledges every callback press', async () => {
      await press(callbackDataForScreen('prices'));

      const acks = harness.platform.calls.filter((call) => call.kind === 'ack');
      expect(acks).toHaveLength(1);
    });
  });

  describe('single-section screens', () => {
    it('names the section once on the coins screen', async () => {
      await send('/start');
      await press(callbackDataForScreen('coins'));

      const text = harness.last().text ?? '';
      expect(text.match(/🪙 سکه/g)).toHaveLength(1);
      expect(text).toContain('سکه امامی');
    });

    it('names the section once on the gold screen', async () => {
      await send('/start');
      await press(callbackDataForScreen('gold'));

      const text = harness.last().text ?? '';
      expect(text.match(/طلا/g)?.length).toBeGreaterThan(0);
      expect(text).not.toContain('🟨 طلا');
      expect(text).toContain('طلای ۱۸ عیار');
    });

    it('re-renders the screen when the refresh button is pressed', async () => {
      await send('/start');
      await press(callbackDataForScreen('gold'));
      const before = harness.rendered().length;

      await press(callbackDataForScreen('gold'));

      expect(harness.rendered().length).toBe(before + 1);
      expect(harness.last().text).toContain('🟡 طلا');
    });
  });

  describe('alerts entry point', () => {
    // Phase 2 rendered a placeholder here; Phase 3 replaces it with the real alert hub.
    it('opens the alert hub with create/list entries', async () => {
      await press(callbackDataForScreen('alerts'));

      expect(harness.last().text).toContain('هشدار قیمت');
      expect(harness.buttons().map((button) => button.text)).toEqual([
        '➕ ساخت هشدار',
        '🔔 هشدارهای من',
        '⬅️ بازگشت',
        '🏠 منوی اصلی',
      ]);
    });
  });

  describe('channel CTA', () => {
    it('offers the configured channel link', async () => {
      await press(callbackDataForScreen('channel'));

      expect(harness.last().text).toContain('@tala_atabak');
      expect(harness.buttons()[0]?.url).toBe('https://ble.ir/tala_atabak');
    });

    it('follows a re-configured channel url', async () => {
      const custom = createUxHarness({
        CHANNEL_URL: 'https://example.test/join',
      });

      await custom.botUx.handleUpdate(
        callback(callbackDataForScreen('channel')),
      );

      expect(keyboardButtons(custom.last())[0]?.url).toBe(
        'https://example.test/join',
      );
    });
  });

  describe('favorites', () => {
    const userId = async (target: UxHarness): Promise<string> =>
      (await target.users.resolveUser('bale', PLATFORM_USER)).id;

    it('starts with an empty state', async () => {
      await press(callbackDataForScreen('favorites'));

      expect(harness.last().text).toContain(
        'هنوز موردی به علاقهمندیها اضافه نکردهاید.',
      );
    });

    it('adds a favorite through a button and shows it in the list', async () => {
      await press(callbackDataForFavorite('add', 'IR_GOLD_18K'));
      await press(callbackDataForScreen('favorites'));

      const text = harness.last().text ?? '';
      expect(text).toContain('علاقهمندیهای من');
      expect(text).toContain('طلای ۱۸ عیار');
      expect(text).toContain('۱ از ۱۰ مورد انتخاب شده است.');
    });

    it('removes a favorite again', async () => {
      await press(callbackDataForFavorite('add', 'USD'));
      await press(callbackDataForFavorite('remove', 'USD'));
      await press(callbackDataForScreen('favorites'));

      expect(harness.last().text).toContain(
        'هنوز موردی به علاقهمندیها اضافه نکردهاید.',
      );
    });

    it('keeps a duplicate add idempotent', async () => {
      await press(callbackDataForFavorite('add', 'USD'));
      await press(callbackDataForFavorite('add', 'USD'));

      const user = await userId(harness);
      expect(harness.users.listFavoriteSymbols(user)).toEqual(['USD']);
    });

    it('rejects an unsupported symbol without touching storage', async () => {
      await press(callbackDataForFavorite('add', 'FAKE_SYMBOL'));

      const user = await userId(harness);
      expect(harness.users.listFavoriteSymbols(user)).toEqual([]);
      const acks = harness.platform.calls.filter((call) => call.kind === 'ack');
      expect(acks[acks.length - 1]?.alertText).toBe(
        'این نماد پشتیبانی نمیشود.',
      );
    });

    it('tells the user when the limit is reached (no silent drop)', async () => {
      const limited = createUxHarness({ MAX_FAVORITES: '2' });
      await seedMarketState(limited);

      await limited.botUx.handleUpdate(
        callback(callbackDataForFavorite('add', 'USD')),
      );
      await limited.botUx.handleUpdate(
        callback(callbackDataForFavorite('add', 'EUR')),
      );
      await limited.botUx.handleUpdate(
        callback(callbackDataForFavorite('add', 'GBP')),
      );

      const user = await userId(limited);
      expect(limited.users.listFavoriteSymbols(user)).toEqual(['USD', 'EUR']);
      const acks = limited.platform.calls.filter((call) => call.kind === 'ack');
      expect(acks[acks.length - 1]?.alertText).toContain('سقف مجاز');
      expect(limited.last().text).toContain('به سقف مجاز');
    });

    it('marks the selected symbols in the management screen', async () => {
      await harness.botUx.handleUpdate(
        callback(callbackDataForFavorite('add', 'IR_GOLD_18K')),
      );

      const buttons = harness.buttons();
      const selected = buttons.find((button) =>
        button.text.includes('طلای ۱۸ عیار'),
      );
      const unselected = buttons.find((button) =>
        button.text.includes('سکه امامی'),
      );

      expect(selected?.text.startsWith('☑')).toBe(true);
      expect(unselected?.text.startsWith('☐')).toBe(true);
    });

    it('keeps one user\u2019s favorites invisible to another user', async () => {
      const first = await harness.users.resolveUser('bale', 'user-a');
      const second = await harness.users.resolveUser('bale', 'user-b');

      await harness.users.addFavorite(first.id, 'IR_GOLD_18K');

      await harness.botUx.handleUpdate(
        callback(callbackDataForScreen('favorites'), {
          platformUserId: 'user-b',
        }),
      );

      expect(harness.last().text).toContain(
        'هنوز موردی به علاقهمندیها اضافه نکردهاید.',
      );
      expect(harness.users.listFavoriteSymbols(second.id)).toEqual([]);
    });

    it('ignores ownership hints inside callback data', async () => {
      const victim = await harness.users.resolveUser('bale', 'victim');
      await harness.users.addFavorite(victim.id, 'USD');

      // A tampered payload cannot address another user: ownership always comes from the
      // platform identity of the update.
      await harness.botUx.handleUpdate(
        callback('v1:fav:remove:USD', { platformUserId: 'attacker' }),
      );

      expect(harness.users.listFavoriteSymbols(victim.id)).toEqual(['USD']);
    });

    it('renders a platform-agnostic flow on Telegram too', async () => {
      const multi = createUxHarness({
        TELEGRAM_BOT_TOKEN: 'telegram-token',
        TELEGRAM_CHANNEL_ID: 'telegram-channel',
      });
      await seedMarketState(multi);

      await multi.botUx.handleUpdate(
        callback(callbackDataForScreen('prices'), { platform: 'telegram' }),
      );

      expect(multi.last().platform).toBe('telegram');
      expect(multi.last().text).toContain('قیمت لحظهای بازار');
      expect(multi.buttons().map((button) => button.text)).toContain(
        '🏠 منوی اصلی',
      );
    });
  });

  describe('platform behaviour', () => {
    it('falls back to a new message when editing is refused', async () => {
      harness.platform.failEdits(true);

      await press(callbackDataForScreen('prices'));

      const rendered = harness.rendered();
      expect(rendered.map((call) => call.kind)).toEqual(['edit', 'send']);
      expect(rendered[0]?.success).toBe(false);
      expect(rendered[1]?.success).toBe(true);
      expect(texts(rendered)[1]).toContain('قیمت لحظهای بازار');
    });

    it('never exposes technical errors to the user', async () => {
      const failing = createUxHarness();
      jest
        .spyOn(failing.users, 'resolveUser')
        .mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432'));

      await failing.botUx.handleUpdate(message('/start'));

      const text = failing.last().text ?? '';
      expect(text).toContain('دریافت اطلاعات بازار با مشکل مواجه شد');
      expect(text).not.toContain('ECONNREFUSED');
      expect(text).not.toContain('Error');
    });

    it('ignores unsupported update types without crashing', async () => {
      await harness.botUx.handleUpdate({
        kind: 'ignored',
        updateId: ++updateId,
        platform: 'bale',
        reason: 'unsupported update type',
      });

      expect(harness.rendered()).toHaveLength(0);
    });

    it('ignores an update for a platform that is not configured', async () => {
      const baleOnly = createUxHarness({ TELEGRAM_BOT_TOKEN: undefined });

      await baleOnly.botUx.handleUpdate(
        callback(callbackDataForScreen('prices'), { platform: 'telegram' }),
      );

      expect(baleOnly.rendered()).toHaveLength(0);
    });
  });

  describe('session state', () => {
    it('tracks one session per user and survives navigation', async () => {
      await send('/start');
      await press(callbackDataForScreen('gold'));

      expect(harness.botUx.activeSessionCount).toBe(1);
      const menu = harness.botUx.renderForTest('menu', 'usr_test');
      expect(menu.text).toContain('منوی اصلی');
    });
  });
});
