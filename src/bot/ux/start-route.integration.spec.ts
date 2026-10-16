import {
  createUxHarness,
  EnvMap,
  seedMarketState,
  UxHarness,
} from '../../testing/test-doubles';
import { InboundCallback, InboundMessage } from '../../platform/platform.types';
import { callbackDataForScreen } from './callback-data';
import { formatChannelUnavailableScreen } from './ux-format';
import { channelKeyboard } from './ux-keyboards';

/**
 * Phase 6 — deep links *routed through the real bot* (§6, §13.5).
 *
 * Everything here runs against the actual router, the actual menu, the actual alert service and the
 * actual alert store — only the network is a double. The point of the suite is what a deep link may
 * **not** do: it can open existing screens, it can start the existing alert wizard, and it can never
 * bypass validation, create data by itself, or reach an administrative surface.
 */

const CHAT_ID = 'chat-route-1';
const PLATFORM_USER = 'route-user-1';

let updateId = 0;

const message = (text: string): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 700 + updateId,
  text,
});

const callback = (data: string): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: CHAT_ID,
  platformUserId: PLATFORM_USER,
  messageId: 700 + updateId,
  data,
  callbackId: `cb-${updateId}`,
});

describe('deep-link routing (§6.2, §6.3)', () => {
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

  const lastText = (): string => harness.last().text ?? '';
  const buttonData = (): (string | undefined)[] =>
    harness.buttons().map((button) => button.callbackData);
  const buttonUrls = (): (string | undefined)[] =>
    harness.buttons().map((button) => button.url);

  beforeEach(async () => {
    await create();
  });

  it('answers a bare /start with the existing welcome screen and the normal menu', async () => {
    await send('/start');

    expect(lastText()).toContain('به بات');
    expect(buttonData()).toContain(callbackDataForScreen('prices'));
    expect(buttonData()).toContain(callbackDataForScreen('alerts'));
  });

  it('opens the existing prices screen for /start prices', async () => {
    await send('/start prices');

    expect(lastText()).toContain('💰 قیمت لحظه');
    expect(buttonData()).toContain('v1:back');
    expect(buttonData()).toContain('v1:home');
  });

  it('opens the existing gold screen for /start gold', async () => {
    await send('/start gold');

    expect(lastText()).toContain('🟡');
    expect(buttonData()).toContain('v1:home');
  });

  it('opens the existing coins screen for /start coin', async () => {
    await send('/start coin');

    expect(lastText()).toContain('سکه');
    expect(buttonData()).toContain('v1:home');
  });

  it('accepts an upper-cased payload (a link that was capitalized still works)', async () => {
    await send('/start GOLD');

    expect(lastText()).toContain('🟡');
  });

  it('ignores tokens after the payload instead of interpreting them', async () => {
    await send('/start gold prices alert');

    expect(lastText()).toContain('🟡');
    expect(lastText()).not.toContain('هشدار شما'); // never an alert screen
  });

  it('opens the channel screen for /start channel when a destination exists', async () => {
    await send('/start channel');

    expect(lastText()).toContain('کانال');
    expect(buttonUrls().some((url) => url?.startsWith('https://'))).toBe(true);
  });

  it('starts the existing alert wizard for /start alert without creating an alert', async () => {
    await send('/start alert');

    const user = harness.store.findUserByPlatform('bale', PLATFORM_USER);
    expect(user).not.toBeNull();
    expect(harness.alerts.listForUser(user?.id ?? '')).toHaveLength(0);
    // The wizard's first step asks for a symbol; nothing is written before the user confirms.
    expect(lastText().length).toBeGreaterThan(10);
  });

  it('explains an unknown payload and continues with the normal menu (never a silent action)', async () => {
    await send('/start something_else');

    expect(lastText()).toContain('تعریف نشده');
    expect(buttonData()).toContain(callbackDataForScreen('prices'));
  });

  it('keeps administrative and publishing surfaces unreachable from a deep link', async () => {
    for (const payload of ['admin', 'publish', 'content', 'cta', 'broadcast']) {
      await send(`/start ${payload}`);
    }

    // No publication, no editorial mutation, no error screen: just the normal menu every time.
    expect(harness.channel.publishes()).toHaveLength(0);
    expect(buttonData()).toContain(callbackDataForScreen('prices'));

    const content = harness.channel.content.list();
    expect(content).toHaveLength(0);
  });

  it('never leaks the bot token into a deep-link answer', async () => {
    await send('/start channel');

    const rendered = harness.last();
    expect(rendered.text ?? '').not.toContain('bot');
    // Neither the text nor the markup of a deep-link answer may carry a platform secret.
    const serialized = JSON.stringify({
      text: rendered.text,
      markup: rendered.markup ?? [],
    });
    expect(serialized).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
    expect(serialized).not.toContain('token');
  });

  it('keeps the existing menu buttons working after a deep link was used', async () => {
    await send('/start gold');
    await harness.botUx.handleUpdate(callback(callbackDataForScreen('prices')));

    expect(lastText()).toContain('💰 قیمت لحظه');
  });

  it('treats a malformed payload like an unknown one instead of crashing the update loop', async () => {
    await send('/start ../../../etc/passwd');

    expect(lastText()).toContain('تعریف نشده');
  });
});

describe('channel invitation on bot screens (§5, §13.5)', () => {
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

  const openReport = async (): Promise<void> => {
    await harness.botUx.handleUpdate(callback(callbackDataForScreen('report')));
  };

  it('adds the invitation line and row to a market-intelligence screen', async () => {
    await create();
    await openReport();

    expect(harness.last().text ?? '').toContain('کانال');
    expect(
      harness
        .buttons()
        .some((button) => button.url === 'https://ble.ir/tala_atabak'),
    ).toBe(true);
  });

  it('keeps the invited screen content intact (the invite is additive, not a replacement)', async () => {
    await create();
    await openReport();

    const text = harness.last().text ?? '';
    expect(text).toContain('گزارش امروز');
    // The original controls are still present next to the invitation.
    expect(
      harness.buttons().some((button) => button.callbackData === 'v1:back'),
    ).toBe(true);
  });

  it('omits the invitation when the feature is switched off', async () => {
    await create({ BOT_CHANNEL_INVITE_ENABLED: 'false' });
    await openReport();

    expect(harness.last().text ?? '').not.toContain('دیدن تحلیل در کانال');
    expect(harness.buttons().every((button) => button.url === undefined)).toBe(
      true,
    );
  });

  it('never attaches the invitation to the main menu itself', async () => {
    await create();
    await harness.botUx.handleUpdate(message('/start'));

    expect(harness.buttons().every((button) => button.url === undefined)).toBe(
      true,
    );
  });

  it('answers a channel request without a destination with an explanation, not a dead button', () => {
    // Configuration-level guard: with no destination the screen explains itself and the keyboard
    // carries no url button at all (this is the defensive pair used by the router).
    expect(formatChannelUnavailableScreen()).toContain('تنظیم نشده');
    expect(
      channelKeyboard(null)
        .flat()
        .every((button) => button.url === undefined),
    ).toBe(true);
  });
});
