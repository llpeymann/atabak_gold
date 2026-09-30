import { of, throwError } from 'rxjs';
import axios from 'axios';

import { BotApiClient } from './bot-api.client';
import {
  createAppConfigService,
  createHttpServiceDouble,
  HttpServiceDouble,
} from '../testing/test-doubles';

const createClient = (
  env: Record<string, string | undefined> = {},
): { client: BotApiClient; http: HttpServiceDouble } => {
  const http = createHttpServiceDouble();
  const config = createAppConfigService({
    BALE_BOT_TOKEN: 'bale-token-123',
    BALE_CHANNEL_ID: 'bale-channel',
    ...env,
  });

  return { client: new BotApiClient(http.service, config), http };
};

describe('BotApiClient', () => {
  describe('inbound parsing', () => {
    it('parses a private message update', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        of({
          data: {
            ok: true,
            result: [
              {
                update_id: 10,
                message: {
                  message_id: 5,
                  from: { id: 4242 },
                  chat: { id: 4242 },
                  text: '/start',
                },
              },
            ],
          },
        }),
      );

      const result = await client.getUpdates('bale', 0, 0);

      expect(result.nextOffset).toBe(11);
      expect(result.updates[0]).toMatchObject({
        kind: 'message',
        platform: 'bale',
        chatId: '4242',
        platformUserId: '4242',
        messageId: 5,
        text: '/start',
      });
    });

    it('parses a callback query update', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        of({
          data: {
            ok: true,
            result: [
              {
                update_id: 11,
                callback_query: {
                  id: 'cb-1',
                  from: { id: 4242 },
                  message: { message_id: 99, chat: { id: 4242 } },
                  data: 'v1:screen:prices',
                },
              },
            ],
          },
        }),
      );

      const result = await client.getUpdates('bale', 0, 0);

      expect(result.updates[0]).toMatchObject({
        kind: 'callback',
        callbackId: 'cb-1',
        messageId: 99,
        data: 'v1:screen:prices',
      });
    });

    it('marks unsupported updates as ignored instead of failing', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        of({
          data: { ok: true, result: [{ update_id: 12, edited_message: {} }] },
        }),
      );

      const result = await client.getUpdates('bale', 0, 0);

      expect(result.updates[0]).toMatchObject({
        kind: 'ignored',
        updateId: 12,
        reason: 'unsupported update type',
      });
      expect(result.nextOffset).toBe(13);
    });

    it('ignores updates without a usable id or sender', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        of({
          data: {
            ok: true,
            result: [
              { message: { text: 'hi' } },
              { update_id: 14, message: { text: 'no sender' } },
            ],
          },
        }),
      );

      const result = await client.getUpdates('bale', 0, 0);

      // The first entry has no usable id (dropped); the second is identifiable but unroutable,
      // so it is reported as ignored instead of crashing the poll loop.
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0]).toMatchObject({
        kind: 'ignored',
        updateId: 14,
      });
      expect(result.nextOffset).toBe(15);
    });

    it('returns an empty result when the platform reports an unexpected body', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(of({ data: { ok: true, result: 'nope' } }));

      await expect(client.getUpdates('bale', 0, 0)).resolves.toEqual({
        updates: [],
        nextOffset: 0,
      });
    });
  });

  describe('outbound calls', () => {
    it('sends a message with the inline keyboard and HTML parse mode', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        of({ data: { ok: true, result: { message_id: 5 } } }),
      );

      const result = await client.sendMessage('bale', 'chat', 'hello', {
        inline_keyboard: [[{ text: 'x', callback_data: 'v1:menu' }]],
      });

      expect(result).toMatchObject({
        success: true,
        edited: false,
        messageId: 5,
      });
      expect(http.post).toHaveBeenCalledWith(
        expect.stringContaining('/botbale-token-123/sendMessage'),
        expect.objectContaining({
          chat_id: 'chat',
          text: 'hello',
          parse_mode: 'HTML',
        }),
        expect.objectContaining({ timeout: 2000 }),
      );
    });

    it('forwards a reply markup to the platform untouched', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        of({ data: { ok: true, result: { message_id: 5 } } }),
      );

      const markup = {
        inline_keyboard: [[{ text: 'x', callback_data: 'v1:menu' }]],
      };
      await client.sendMessage('bale', 'chat', 'hello', markup);

      expect(http.post).toHaveBeenCalledWith(
        expect.stringContaining('/sendMessage'),
        expect.objectContaining({ reply_markup: markup }),
        expect.anything(),
      );
    });

    it('edits an existing message', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        of({ data: { ok: true, result: { message_id: 7 } } }),
      );

      const result = await client.editMessageText('bale', 'chat', 7, 'updated');

      expect(result).toMatchObject({
        success: true,
        edited: true,
        messageId: 7,
      });
      expect(http.post).toHaveBeenCalledWith(
        expect.stringContaining('/editMessageText'),
        expect.objectContaining({ message_id: 7 }),
        expect.anything(),
      );
    });

    it('reports ok=false responses with the platform description', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        of({ data: { ok: false, description: 'chat not found' } }),
      );

      const result = await client.sendMessage('bale', 'chat', 'hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('chat not found');
    });

    it('never leaks the bot token in an error description', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        throwError(() =>
          axios.AxiosError.from(
            new Error('connect ECONNREFUSED'),
            undefined,
            undefined,
            undefined,
            {
              status: 500,
              statusText: 'error',
              headers: {},
              config: {} as never,
              data: {
                url: 'https://tapi.bale.ai/botbale-token-123/sendMessage',
              },
            },
          ),
        ),
      );

      const result = await client.sendMessage('bale', 'chat', 'hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
      expect(result.error).not.toContain('bale-token-123');
      expect(result.error).toContain('***');
    });

    it('reports a failure instead of throwing when the transport dies', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(
        throwError(() => new Error('timeout of 2000ms exceeded')),
      );

      const result = await client.sendMessage('bale', 'chat', 'hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('refuses to call an unconfigured platform', async () => {
      const { client, http } = createClient({ TELEGRAM_BOT_TOKEN: undefined });

      const result = await client.sendMessage('telegram', 'chat', 'hello');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
      expect(http.post).not.toHaveBeenCalled();
    });

    it('swallows callback acknowledgement failures (they are cosmetic)', async () => {
      const { client, http } = createClient();
      http.post.mockReturnValue(throwError(() => new Error('boom')));

      await expect(
        client.answerCallbackQuery('bale', 'cb-1'),
      ).resolves.toBeUndefined();
    });

    it('lists the configured platforms', () => {
      expect(createClient().client.configuredPlatforms()).toEqual(['bale']);
      expect(
        createClient({
          TELEGRAM_BOT_TOKEN: 'tg',
          TELEGRAM_CHANNEL_ID: 'tg-channel',
        }).client.configuredPlatforms(),
      ).toEqual(['bale', 'telegram']);
    });

    it('uses a long-poll timeout only for getUpdates', async () => {
      const { client, http } = createClient({
        DELIVERY_TIMEOUT_MS: '1500',
        BOT_POLL_TIMEOUT_SECONDS: '25',
      });
      http.post.mockReturnValue(of({ data: { ok: true, result: [] } }));

      await client.getUpdates('bale', 0, 25);
      await client.sendMessage('bale', 'chat', 'hi');

      const pollOptions = http.post.mock.calls[0]?.[2];
      const sendOptions = http.post.mock.calls[1]?.[2];

      expect(pollOptions).toEqual(expect.objectContaining({ timeout: 35_000 }));
      expect(sendOptions).toEqual(expect.objectContaining({ timeout: 1_500 }));
    });
  });
});
