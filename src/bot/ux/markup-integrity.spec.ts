import {
  callbackDataForFavorite,
  callbackDataForScreen,
} from './callback-data';
import {
  createUxHarness,
  seedMarketState,
  UxHarness,
} from '../../testing/test-doubles';
import { InboundCallback, InboundMessage } from '../../platform/platform.types';

/**
 * Every user-visible message is HTML-parsed by the platform, so the rendering layer must emit
 * well-formed markup and must never show the user raw tags.
 *
 * This guard renders each screen (including the stale, empty and error variants) and fails if a
 * message contains an escaped tag (`&lt;b&gt;`), a nested duplicate emphasis (`<b><b>`), or an
 * unbalanced tag. It exists because the section titles used to reach the formatter with their own
 * markup, which escaped them into literal text in the live bot.
 */
const USER = 'markup-audit-user';

let updateId = 0;

const message = (text: string): InboundMessage => ({
  kind: 'message',
  updateId: ++updateId,
  platform: 'bale',
  chatId: 'chat-1',
  platformUserId: USER,
  messageId: 600 + updateId,
  text,
});

const callback = (data: string): InboundCallback => ({
  kind: 'callback',
  updateId: ++updateId,
  platform: 'bale',
  chatId: 'chat-1',
  platformUserId: USER,
  messageId: 888,
  callbackId: `cb-${updateId}`,
  data,
});

const ESCAPED_TAG = /&lt;\/?[a-z]+&gt;|&amp;lt;|&amp;gt;/i;
const NESTED_TAG = /<(b|strong)>\s*<(b|strong)>/i;

/** Tag names must open and close in a consistent order on every rendered message. */
function assertBalancedTags(text: string, screen: string): void {
  const stack: string[] = [];
  const tagPattern = /<(\/?)([a-z]+)(?:\s[^>]*)?>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(text)) !== null) {
    const [, closing, rawName] = match;
    const name = rawName.toLowerCase();

    if (closing) {
      const open = stack.pop();
      expect({ screen, closed: name, opened: open }).toEqual({
        screen,
        closed: name,
        opened: name,
      });
    } else {
      stack.push(name);
    }
  }

  expect({ screen, unclosed: stack }).toEqual({ screen, unclosed: [] });
}

function assertCleanMarkup(text: string, screen: string): void {
  expect({ screen, text: ESCAPED_TAG.test(text) ? text : null }).toEqual({
    screen,
    text: null,
  });
  expect({ screen, text: NESTED_TAG.test(text) ? text : null }).toEqual({
    screen,
    text: null,
  });
  assertBalancedTags(text, screen);
}

interface Scenario {
  name: string;
  prepare?: (harness: UxHarness) => Promise<void>;
  update: () => InboundMessage | InboundCallback;
}

const scenarios: Scenario[] = [
  {
    name: 'start',
    update: () => message('/start'),
  },
  {
    name: 'menu',
    update: () => message('/menu'),
  },
  {
    name: 'prices',
    update: () => callback(callbackDataForScreen('prices')),
  },
  {
    name: 'gold',
    update: () => callback(callbackDataForScreen('gold')),
  },
  {
    name: 'coins',
    update: () => callback(callbackDataForScreen('coins')),
  },
  {
    name: 'market',
    update: () => callback(callbackDataForScreen('market')),
  },
  {
    name: 'favorites (empty)',
    update: () => callback(callbackDataForScreen('favorites')),
  },
  {
    name: 'favorites (with an item)',
    prepare: async (harness) => {
      await harness.botUx.handleUpdate(
        callback(callbackDataForFavorite('add', 'IR_GOLD_18K')),
      );
    },
    update: () => callback(callbackDataForScreen('favorites')),
  },
  {
    name: 'favorites management',
    update: () => callback(callbackDataForScreen('favoritesManage')),
  },
  {
    name: 'alerts placeholder',
    update: () => callback(callbackDataForScreen('alerts')),
  },
  {
    name: 'channel',
    update: () => callback(callbackDataForScreen('channel')),
  },
  {
    name: 'invalid callback',
    update: () => callback('v1:no-such-action'),
  },
  {
    name: 'stale prices',
    prepare: async (harness) => {
      const stale = createUxHarness({ PRICE_STALE_AFTER_MINUTES: '1' });
      await seedMarketState(stale, {
        receivedAt: new Date(Date.now() - 10 * 60_000),
      });
      // Reuse the stale harness's market state inside this scenario's stack.
      Object.assign(harness.market.marketState, {
        getState: (): unknown => stale.market.marketState.getState() as unknown,
      });
    },
    update: () => callback(callbackDataForScreen('prices')),
  },
  {
    name: 'empty market state',
    prepare: (harness) => {
      Object.assign(harness.market.marketState, {
        getState: () => ({
          symbols: [],
          dayKey: null,
          freshness: 'unknown',
          updatedAt: null,
        }),
      });
    },
    update: () => callback(callbackDataForScreen('market')),
  },
];

describe('rendered markup integrity', () => {
  for (const scenario of scenarios) {
    it(`renders "${scenario.name}" without escaped or malformed tags`, async () => {
      const harness = createUxHarness();

      if (
        scenario.name !== 'stale prices' &&
        scenario.name !== 'empty market state'
      ) {
        await seedMarketState(harness);
      }

      await scenario.prepare?.(harness);

      await harness.botUx.handleUpdate(scenario.update());

      const rendered = harness.rendered();
      expect(rendered.length).toBeGreaterThan(0);

      for (const call of rendered) {
        assertCleanMarkup(call.text ?? '', scenario.name);
      }

      for (const button of harness.buttons()) {
        assertCleanMarkup(button.text, `${scenario.name} → button`);
      }
    });
  }

  it('keeps the section titles free of delivery markup', async () => {
    const harness = createUxHarness();
    await seedMarketState(harness);
    await harness.botUx.handleUpdate(callback(callbackDataForScreen('prices')));

    const text = harness.last().text ?? '';

    // The titles are re-emphasized exactly once by the formatter.
    expect(text).toContain('<b>🟨 طلا</b>');
    expect(text).toContain('<b>🪙 سکه</b>');
    expect(text).toContain('<b>💰 بازار ارز</b>');
    expect(text).not.toContain('<b><b>');
  });
});
