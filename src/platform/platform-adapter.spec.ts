import { asCommand, toReplyMarkup } from './platform-adapter';
import { InboundMessage } from './platform.types';

const messageOf = (text: string | null): InboundMessage => ({
  kind: 'message',
  updateId: 1,
  platform: 'bale',
  chatId: 'chat',
  platformUserId: 'user',
  messageId: 1,
  text,
});

describe('platform adapter helpers', () => {
  describe('toReplyMarkup', () => {
    it('renders callback buttons', () => {
      expect(
        toReplyMarkup([
          [{ text: '💰 قیمت', callbackData: 'v1:screen:prices' }],
        ]),
      ).toEqual({
        inline_keyboard: [
          [{ text: '💰 قیمت', callback_data: 'v1:screen:prices' }],
        ],
      });
    });

    it('renders url buttons without callback data', () => {
      expect(
        toReplyMarkup([[{ text: '📢 کانال', url: 'https://ble.ir/x' }]]),
      ).toEqual({
        inline_keyboard: [[{ text: '📢 کانال', url: 'https://ble.ir/x' }]],
      });
    });

    it('keeps the row layout of a multi-row keyboard', () => {
      const markup = toReplyMarkup([
        [{ text: 'a', callbackData: 'v1:menu' }],
        [
          { text: 'b', callbackData: 'v1:home' },
          { text: 'c', callbackData: 'v1:back' },
        ],
      ]) as { inline_keyboard: unknown[] };

      expect(markup.inline_keyboard).toHaveLength(2);
    });

    it('produces no markup for an empty keyboard', () => {
      expect(toReplyMarkup(null)).toBeUndefined();
      expect(toReplyMarkup([])).toBeUndefined();
    });
  });

  describe('asCommand', () => {
    it('recognizes a plain command', () => {
      expect(asCommand(messageOf('/start'))).toBe('start');
    });

    it('strips a bot mention and arguments', () => {
      expect(asCommand(messageOf('/prices@atabak_bot now'))).toBe('prices');
    });

    it('is case-insensitive', () => {
      expect(asCommand(messageOf('/MENU'))).toBe('menu');
    });

    it('ignores plain text, empty text and a bare slash', () => {
      expect(asCommand(messageOf('سلام'))).toBeNull();
      expect(asCommand(messageOf(null))).toBeNull();
      expect(asCommand(messageOf('/'))).toBeNull();
    });
  });
});
