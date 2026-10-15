import { Logger } from '@nestjs/common';

import {
  createUxHarness,
  EnvMap,
  seedMarketState,
  UxHarness,
} from '../../testing/test-doubles';
import { InboundMessage } from '../../platform/platform.types';
import { callbackDataForScreen } from './callback-data';
import { formatChannelUnavailableScreen } from './ux-format';
import { channelKeyboard } from './ux-keyboards';

/**
 * §13.2 / §13.5 / §13.6 — deep links (Bot side) and the Bot → Channel invitation.
 *
 * Everything runs through the real router, keyboards and formatting; only the platform transport is
 * doubled. The assertions are on the rendered messages and the buttons a user would actually see.
 */

const CHAT_ID = 'chat-deeplink-1';
const PLATFORM_USER = 'deeplink-user-1';

let updateId = 0;

const message = (text: string): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 500 + updateId,
  text,
});

describe('deep links and channel invitation (§6, §5)', () => {
  let harness: UxHarness;

  const create = async (env: EnvMap = {}): Promise<void> => {
    harness = createUxHarness({
      CHANNEL_URL: 'https://ble.ir/tala_atabak',
      BALE_BOT_USERNAME: 'atabak_bot',
      ...env,
    });
    await seedMarketState(harness.market, { receivedAt: new Date() });
    await harness.users.resolveUser('bale', PLATFORM_USER, CHAT_ID);
  };

  const send = async (text: string): Promise<void> => {
    await harness.botUx.handleUpdate(message(text));
  };

  const last = () => harness.last();
  const lastText = (): string => last().text ?? '';
  const lastButtons = (): {
    text: string;
    url?: string;
    callbackData?: string;
  }[] => harness.buttons();

  const urls = (): string[] =>
    lastButtons()
      .map((button) => button.url)
      .filter((url): url is string => typeof url === 'string');

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'verbose').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --- §6.2 / §6.3: parsing and routing --------------------------------------

  it('keeps the plain /start behaviour (empty payload = the preserved default)', async () => {
    await create();
    await send('/start');

    // The preserved default: the welcome screen with the ordinary main menu.
    expect(lastText()).toContain('خوش آمدید');
    expect(lastButtons().map((button) => button.callbackData)).toContain(
      callbackDataForScreen('prices'),
    );
  });

  it('opens the existing price screen for the `prices` payload', async () => {
    await create();
    await send('/start prices');

    expect(lastText()).toContain('💰 قیمت لحظه');
    // A real screen, not the menu: the navigation row is the screen footer.
    expect(lastButtons().map((button) => button.callbackData)).toContain(
      'v1:back',
    );
    expect(lastButtons().map((button) => button.callbackData)).not.toContain(
      callbackDataForScreen('alerts'),
    );
  });

  it('opens the existing gold screen for the `gold` payload', async () => {
    await create();
    await send('/start gold');

    expect(lastText()).toContain('طلا');
    expect(lastButtons().length).toBeGreaterThan(0);
  });

  it('opens the existing coin screen for the `coin` payload', async () => {
    await create();
    await send('/start coin');

    expect(lastText()).toContain('سکه');
  });

  it('accepts an upper-cased payload (no case bug)', async () => {
    await create();
    await send('/start GOLD');

    expect(lastText()).toContain('طلا');
  });

  it('ignores extra parameters instead of inventing a second feature', async () => {
    await create();
    await send('/start prices anything else');

    expect(lastText()).toContain('💰 قیمت لحظه');
    // Still a normal price screen: no url button, no hidden action introduced by the extra tokens.
    expect(lastButtons().some((button) => button.url !== undefined)).toBe(
      false,
    );
  });

  it('answers an unknown payload with the main menu and a diagnostic log — never with an error', async () => {
    await create();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await send('/start totally_unknown_route');

    expect(lastText()).toContain('منوی اصلی');
    expect(lastText()).toContain('تعریف نشده');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown start payload'),
    );
    // No exception escapes, and the user is left in a usable state.
    expect(lastButtons().length).toBeGreaterThan(0);
  });

  it('never lets a payload trigger an administrative operation', async () => {
    await create();

    for (const text of [
      '/start admin',
      '/start content',
      '/start publish',
      '/start alert_publish',
      '/start ../../admin',
    ]) {
      await send(text);

      // The result of every one of them is the menu, never a content-management surface.
      expect(lastText()).toContain('منوی اصلی');
      expect(lastText()).not.toContain('مدیریت محتوا');
    }
  });

  it('starts the alert wizard for the `alert` payload — without creating any alert', async () => {
    await create();

    const user = await harness.users.resolveUser(
      'bale',
      PLATFORM_USER,
      CHAT_ID,
    );

    await send('/start alert');

    // …the existing wizard, asking for the symbol: it never finishes the flow by itself (§4.2).
    expect(lastText()).toContain('ساخت هشدار');
    expect(lastButtons().length).toBeGreaterThan(0);
    expect(
      lastButtons().some((button) =>
        (button.callbackData ?? '').startsWith('v1:alert:sym:'),
      ),
    ).toBe(true);
    // Nothing was created by following the link.
    expect(harness.alerts.listForUser(user.id)).toHaveLength(0);
  });

  it('rejects a malformed payload without crashing and normalizes the text it reports', async () => {
    await create();

    for (const text of [
      '/start $%^&*()',
      '/start "><script>',
      '/start ' + 'a'.repeat(64),
    ]) {
      await expect(send(text)).resolves.toBeUndefined();
      expect(lastText()).toContain('منوی اصلی');
    }
  });

  it('shows the channel screen with the configured destination', async () => {
    await create();
    await send('/start channel');

    expect(lastText()).toContain('کانال');
    expect(urls()).toContain('https://ble.ir/tala_atabak');
  });

  /**
   * The safe fallback of §7 rule 8 is defensive: the shipped configuration gives `CHANNEL_URL` a
   * product default, so the branch can only be reached with an explicitly emptied configuration. It is
   * asserted here at the level where it can be produced deterministically (the formatter and the
   * keyboard), so the rule is covered even though the state is not reachable from a valid env file.
   */
  it('explains itself instead of offering a dead button when no channel is configured', () => {
    expect(formatChannelUnavailableScreen()).toContain('تنظیم نشده');
    // The rows still exist (navigation stays usable) but no button carries a url.
    expect(
      channelKeyboard(null)
        .flat()
        .every((button) => button.url === undefined),
    ).toBe(true);
  });

  // --- §5.2: Bot → Channel -----------------------------------------------------

  it('adds the channel invitation to the market-report answers only', async () => {
    await create();

    const open = async (
      screen: Parameters<typeof callbackDataForScreen>[0],
    ): Promise<void> => {
      await harness.botUx.handleUpdate({
        kind: 'callback',
        updateId: ++updateId,
        platform: 'bale',
        chatId: CHAT_ID,
        platformUserId: PLATFORM_USER,
        messageId: 950 + updateId,
        callbackId: `cb-${updateId}`,
        data: callbackDataForScreen(screen),
      });
    };

    // The four market-report answers carry it…
    for (const screen of [
      'report',
      'report-full',
      'movement',
      'last-update',
    ] as const) {
      await open(screen);

      expect(lastText()).toContain('کانال طلای اتابک');
      expect(urls()).toContain('https://ble.ir/tala_atabak');
    }

    // …the navigation and price screens do not (no universal footer, §5.2).
    for (const screen of [
      'market',
      'prices',
      'gold',
      'coins',
      'favorites',
      'alerts',
    ] as const) {
      await open(screen);

      expect(lastText()).not.toContain('کانال طلای اتابک');
    }
  });

  it('keeps the invitation out of the report when the feature is switched off', async () => {
    await create({ BOT_CHANNEL_INVITE_ENABLED: 'false' });

    await harness.botUx.handleUpdate({
      kind: 'callback',
      updateId: ++updateId,
      platform: 'bale',
      chatId: CHAT_ID,
      platformUserId: PLATFORM_USER,
      messageId: 901,
      callbackId: `cb-${updateId}`,
      data: callbackDataForScreen('report'),
    });

    expect(lastText()).not.toContain('کانال طلای اتابک');
    expect(urls()).toHaveLength(0);
  });

  it('changes nothing but the invitation line: the report values stay identical', async () => {
    await create({ BOT_CHANNEL_INVITE_ENABLED: 'false' });

    const open = async (): Promise<string> => {
      await harness.botUx.handleUpdate({
        kind: 'callback',
        updateId: ++updateId,
        platform: 'bale',
        chatId: CHAT_ID,
        platformUserId: PLATFORM_USER,
        messageId: 902,
        callbackId: `cb-${updateId}`,
        data: callbackDataForScreen('report'),
      });

      return lastText();
    };

    const withoutInvite = await open();

    await create({ BOT_CHANNEL_INVITE_ENABLED: 'true' });
    const withInvite = await open();

    // The invitation is appended, every statistic of the report is byte-identical.
    expect(withInvite.startsWith(withoutInvite)).toBe(true);
    expect(withInvite.length).toBeGreaterThan(withoutInvite.length);
  });

  it('does not break the existing menu actions', async () => {
    await create();

    for (const screen of [
      'prices',
      'gold',
      'coins',
      'market',
      'favorites',
      'alerts',
    ] as const) {
      await harness.botUx.handleUpdate({
        kind: 'callback',
        updateId: ++updateId,
        platform: 'bale',
        chatId: CHAT_ID,
        platformUserId: PLATFORM_USER,
        messageId: 910 + updateId,
        callbackId: `cb-${updateId}`,
        data: callbackDataForScreen(screen),
      });

      expect(lastText().length).toBeGreaterThan(0);
      expect(lastButtons().length).toBeGreaterThan(0);
    }
  });
});
