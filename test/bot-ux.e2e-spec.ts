import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { readFile } from 'node:fs/promises';
import { of } from 'rxjs';

import { AppModule } from './../src/app.module';
import { BotService } from './../src/bot/bot.service';
import { BotUxService } from './../src/bot/ux/bot-ux.service';
import { MarketEngineService } from './../src/market/market-engine.service';
import { UserStore } from './../src/users/user.store';
import {
  InboundCallback,
  InboundMessage,
} from './../src/platform/platform.types';
import {
  DEFAULT_SEED_PRICES,
  rawPricePayload,
} from './../src/testing/test-doubles';

const PLATFORM_USER = 'e2e-user';
const CHAT_ID = 'e2e-chat';

interface WireCall {
  url: string;
  body: Record<string, unknown>;
}

let updateId = 0;

const message = (text: string): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 300 + updateId,
  text,
});

const callback = (data: string): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 555,
  callbackId: `cb-${updateId}`,
  data,
});

/**
 * Phase 2 §57 — the major user flows end to end.
 *
 * The whole application boots (real module graph: config, market engine, user store, platform
 * adapters, UX router). Only the Bot API transport is replaced, so every platform call is
 * observable and no network access is required. The external price API is never configured with
 * a reachable host — proving that nothing in the interaction path tries to reach it.
 */
describe('Bot UX (e2e)', () => {
  let app: INestApplication;
  let botUx: BotUxService;
  let engine: MarketEngineService;
  let store: UserStore;
  let wire: WireCall[];
  /** Throw-away data files created by `test/setup-env.ts` (never inside the repository). */
  let userDataFile: string;

  beforeAll(() => {
    userDataFile = process.env.USER_DATA_FILE ?? '';
    expect(userDataFile).not.toBe('');
    expect(userDataFile).not.toContain('/home/user/atabak_gold');
  });

  beforeEach(async () => {
    wire = [];
    const httpDouble = {
      post: (url: string, body: Record<string, unknown>) => {
        wire.push({ url, body });
        // `getUpdates` answers with an empty update list; everything else looks like a send.
        const result = url.endsWith('/getUpdates')
          ? []
          : { message_id: 900 + wire.length };
        return of({ data: { ok: true, result } });
      },
      // The scheduled publication fetches the raw market payload through this transport.
      get: (url: string) => {
        wire.push({ url, body: {} });
        return of({ data: rawPricePayload(DEFAULT_SEED_PRICES) });
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HttpService)
      .useValue(httpDouble)
      .compile();

    app = moduleFixture.createNestApplication();
    app.enableShutdownHooks();
    await app.init();

    botUx = app.get(BotUxService);
    engine = app.get(MarketEngineService);
    store = app.get(UserStore);

    // One scheduler cycle: external payload → Phase 1 pipeline → validated market state.
    await engine.evaluateCycle(
      rawPricePayload(DEFAULT_SEED_PRICES),
      new Date(),
    );
  });

  afterEach(async () => {
    await app.close();
  });

  const lastText = (): string => {
    const body = wire.at(-1)?.body;
    return typeof body?.text === 'string' ? body.text : '';
  };

  const botApiCalls = (): WireCall[] =>
    wire.filter((call) => call.url.startsWith('https://tapi.bale.ai'));

  /** Message calls only — acknowledgements are not user-visible messages. */
  const messageCalls = (): WireCall[] =>
    botApiCalls().filter(
      (call) =>
        call.url.endsWith('/sendMessage') ||
        call.url.endsWith('/editMessageText'),
    );

  it('serves /start with the main menu', async () => {
    await botUx.handleUpdate(message('/start'));

    expect(lastText()).toContain('طلای اتابک');
    const markup = wire.at(-1)?.body.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    expect(markup.inline_keyboard.flat().map((button) => button.text)).toEqual([
      '💰 قیمت لحظهای',
      '🟡 طلا',
      '🪙 سکه',
      '📊 بازار',
      '🔔 هشدار',
      '⭐ علاقهمندیها',
      '📢 کانال اتابک',
    ]);
  });

  it('walks the whole first-time user journey without technical commands', async () => {
    await botUx.handleUpdate(message('/start'));
    await botUx.handleUpdate(callback('v1:screen:prices'));
    expect(lastText()).toContain('💰 قیمت لحظهای بازار');

    await botUx.handleUpdate(callback('v1:back'));
    expect(lastText()).toContain('منوی اصلی');

    await botUx.handleUpdate(callback('v1:screen:gold'));
    expect(lastText()).toContain('🟡 طلا');

    await botUx.handleUpdate(callback('v1:back'));
    await botUx.handleUpdate(callback('v1:screen:coins'));
    expect(lastText()).toContain('🪙 سکه');

    await botUx.handleUpdate(callback('v1:back'));
    await botUx.handleUpdate(callback('v1:screen:market'));
    // Phase 4 turned `📊 بازار` into the hub of the market intelligence reports.
    expect(lastText()).toContain('📊 <b>بازار</b>');
    expect(lastText()).toContain('📊 گزارش امروز');
    expect(lastText()).toContain('📈 حرکت بازار');
    expect(lastText()).toContain('🕐 آخرین بروزرسانی');

    await botUx.handleUpdate(callback('v1:back'));
    await botUx.handleUpdate(callback('v1:screen:report'));
    expect(lastText()).toContain('📊 <b>گزارش امروز</b>');
    expect(lastText()).toContain('تغییر روزانه:');

    await botUx.handleUpdate(callback('v1:back'));
    await botUx.handleUpdate(callback('v1:screen:favorites'));
    expect(lastText()).toContain('علاقهمندیهای من');

    await botUx.handleUpdate(callback('v1:fav:manage'));
    await botUx.handleUpdate(callback('v1:fav:add:IR_GOLD_18K'));
    await botUx.handleUpdate(callback('v1:fav:remove:IR_GOLD_18K'));
    await botUx.handleUpdate(callback('v1:back'));
    expect(lastText()).toContain('علاقهمندیهای من');

    await botUx.handleUpdate(callback('v1:back'));
    // Phase 3 replaced the Phase 2 placeholder with the real alert section.
    await botUx.handleUpdate(callback('v1:screen:alerts'));
    expect(lastText()).toContain('🔔 <b>هشدار قیمت</b>');
    expect(lastText()).toContain('هشدارهای من');

    await botUx.handleUpdate(callback('v1:back'));
    await botUx.handleUpdate(callback('v1:screen:channel'));
    expect(lastText()).toContain('@tala_atabak');

    await botUx.handleUpdate(callback('v1:home'));
    expect(lastText()).toContain('منوی اصلی');
  });

  it('edits the menu message instead of sending a new one', async () => {
    await botUx.handleUpdate(message('/start'));
    const messagesBefore = messageCalls().length;

    await botUx.handleUpdate(callback('v1:screen:prices'));

    const edits = messageCalls().filter((call) =>
      call.url.endsWith('/editMessageText'),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]?.body.message_id).toBe(555);
    // Exactly one new message call, and it is the edit — no duplicate send.
    expect(messageCalls()).toHaveLength(messagesBefore + 1);
  });

  it('persists favorites across a full application restart', async () => {
    await botUx.handleUpdate(message('/start'));
    await botUx.handleUpdate(callback('v1:fav:add:IR_COIN_EMAMI'));

    expect(store.path).toBe(userDataFile);
    const stored = JSON.parse(await readFile(userDataFile, 'utf-8')) as {
      favorites: { symbol: string }[];
    };
    expect(stored.favorites.map((favorite) => favorite.symbol)).toEqual([
      'IR_COIN_EMAMI',
    ]);

    // Restart: a new application instance over the same files.
    await app.close();
    const restarted = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(HttpService)
      .useValue({
        post: (url: string, body: Record<string, unknown>) => {
          wire.push({ url, body });
          const result = url.endsWith('/getUpdates') ? [] : { message_id: 999 };
          return of({ data: { ok: true, result } });
        },
        get: (url: string) => {
          wire.push({ url, body: {} });
          return of({ data: rawPricePayload(DEFAULT_SEED_PRICES) });
        },
      })
      .compile();
    app = restarted.createNestApplication();
    await app.init();

    const restartedUx = app.get(BotUxService);
    const restartedStore = app.get(UserStore);
    await restartedStore.ensureLoaded();
    const restoredUser = (await selectUser(restartedStore))!;

    expect(
      restartedStore
        .listFavorites(restoredUser.id)
        .map((favorite) => favorite.symbol),
    ).toEqual(['IR_COIN_EMAMI']);

    await restartedUx.handleUpdate(callback('v1:screen:favorites'));

    expect(lastText()).toContain('سکه امامی');
    expect(lastText()).toContain('۱ از ۱۰ مورد انتخاب شده است.');
  });

  const selectUser = async (target: UserStore) => {
    await target.ensureLoaded();
    return target
      .listUsers()
      .find((candidate) => candidate.platformUserId === PLATFORM_USER);
  };

  it('never touches the external price API from the interaction path', async () => {
    await botUx.handleUpdate(message('/start'));
    await botUx.handleUpdate(callback('v1:screen:prices'));
    await botUx.handleUpdate(callback('v1:screen:market'));
    await botUx.handleUpdate(callback('v1:screen:favorites'));

    // Every outbound call went to the bot platform — none to the market provider.
    for (const call of wire) {
      expect(call.url).not.toContain('api.example.test');
    }
    expect(botApiCalls().length).toBeGreaterThan(0);
  });

  it('answers an outdated button safely', async () => {
    await botUx.handleUpdate(callback('v2:screen:prices'));

    expect(lastText()).toContain('این گزینه دیگر معتبر نیست.');
  });

  it('keeps the channel publication path working (Phase 1 regression)', async () => {
    // The scheduled publication still goes through the Phase 1 update object.
    const botService = app.get(BotService);

    await botService.handleHalfHourlyPriceUpdate();

    // The pipeline fetched the raw payload (get), validated it and published to the channel.
    expect(wire.some((call) => call.url.includes('/prices'))).toBe(true);

    const channelSend = wire.find(
      (call) =>
        call.url.endsWith('/sendMessage') &&
        call.body.chat_id === process.env.BALE_CHANNEL_ID,
    );

    expect(channelSend).toBeDefined();
    const bodyText = channelSend?.body.text;
    const text = typeof bodyText === 'string' ? bodyText : '';
    expect(text).toContain('گزارش');
    expect(text).toContain('ریال');
    expect(text).toContain('@tala_atabak');
  });
});
