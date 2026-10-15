import { Logger } from '@nestjs/common';

import { createUxHarness, UxHarness } from '../../testing/test-doubles';
import { InboundUpdate } from '../../platform/platform.types';
import { parseContentCommand } from './content-admin.service';
import { CTA_CHOICES } from '../../channel/channel.types';

/**
 * §13.3 (admin surface) — `/content cta` and `ContentService.setCta`.
 *
 * The admin command is the only way an editorial item can choose its button (and the only way an
 * alert-promotion post can exist, because the registry has no promotion type). It must behave like
 * every other editorial edit: validated input, a new revision, a reset approval state.
 */

const ADMIN = 'bale:100';

const message = (
  text: string,
  platformUserId: string,
  updateId: number,
): InboundUpdate =>
  ({
    kind: 'message',
    platform: 'bale',
    updateId,
    platformUserId,
    chatId: platformUserId,
    text,
  }) as unknown as InboundUpdate;

describe('content CTA command (§13.3)', () => {
  let harness: UxHarness;
  let updateId = 0;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    harness = createUxHarness({ CHANNEL_ADMIN_USER_IDS: ADMIN });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const send = async (text: string): Promise<void> => {
    await harness.botUx.handleUpdate(message(text, ADMIN, ++updateId));
  };

  const texts = (): string[] =>
    harness.rendered().map((call) => call.text ?? '');

  const lastText = (): string => harness.last().text ?? '';

  const create = async (): Promise<string> => {
    await send('/content new EDUCATIONAL\nعنوان تست\nمتن تست');
    const item = harness.channel.content.list()[0];

    expect(item).toBeDefined();

    return item?.id ?? '';
  };

  it('parses the grammar of the command', () => {
    expect(parseContentCommand('/content cta cnt_1 alert')).toEqual({
      action: 'cta',
      id: 'cnt_1',
      argument: 'alert',
    });
    expect(parseContentCommand('/content cta cnt_1 none')).toEqual({
      action: 'cta',
      id: 'cnt_1',
      argument: 'none',
    });
    // Malformed requests are rejected as a whole — never partially applied.
    expect(parseContentCommand('/content cta cnt_1')).toEqual({
      action: 'invalid',
    });
    expect(parseContentCommand('/content cta cnt_1')).toEqual({
      action: 'invalid',
    });
    expect(parseContentCommand('/content cta cnt_1 alert extra')).toEqual({
      action: 'invalid',
    });
  });

  it('accepts every documented choice and stores it', async () => {
    const id = await create();

    for (const choice of CTA_CHOICES) {
      await send(`/content cta ${id} ${choice}`);

      const stored = harness.channel.content.find(id);

      // A missing value *is* `auto` (§4.2): the no-op path therefore stores nothing new.
      expect(stored?.ctaRoute ?? 'auto').toBe(choice);
    }
  });

  it('rejects an unknown choice without changing the item', async () => {
    const id = await create();
    const before = harness.channel.content.find(id);

    await send(`/content cta ${id} nonsense`);

    expect(lastText()).toContain('باید یکی از این‌ها باشد');
    expect(harness.channel.content.find(id)).toEqual(before);
  });

  it('requests a new approval and a new revision (the button is part of the post)', async () => {
    const id = await create();

    await send(`/content approve ${id}`);
    const approved = harness.channel.content.find(id);

    expect(approved?.status).toBe('APPROVED');

    await send(`/content cta ${id} gold`);

    const edited = harness.channel.content.find(id);

    expect(edited?.ctaRoute).toBe('gold');
    expect(edited?.status).toBe('DRAFT');
    expect(edited?.revision).toBe((approved?.revision ?? 0) + 1);
    expect(edited?.approvedAt).toBeNull();
    expect(edited?.approvedBy).toBeNull();
  });

  it('treats an already-current choice as a no-op (no revision churn)', async () => {
    const id = await create();

    await send(`/content cta ${id} prices`);
    const first = harness.channel.content.find(id);

    await send(`/content cta ${id} prices`);
    const second = harness.channel.content.find(id);

    expect(second?.revision).toBe(first?.revision);
    expect(second?.status).toBe(first?.status);
    expect(lastText()).toContain('دکمه پیام');
  });

  it('is refused for a non-admin without disclosing the surface', async () => {
    const id = await create();

    await harness.botUx.handleUpdate(
      message(`/content cta ${id} alert`, 'bale:999', ++updateId),
    );

    expect(lastText()).not.toContain('دکمه پیام');
    expect(harness.channel.content.find(id)?.ctaRoute).toBeUndefined();
  });

  it('shows the CTA state — and its default — on the item view', async () => {
    const id = await create();

    await send(`/content show ${id}`);
    expect(lastText()).toContain('دکمه پیام');
    expect(texts().join('\n')).toContain('خودکار');

    await send(`/content cta ${id} alert`);
    await send(`/content show ${id}`);

    expect(lastText()).toContain('فعال‌سازی هشدار');
  });

  it('lists the command in the help text', async () => {
    await send('/content help');

    expect(lastText()).toContain('/content cta');
  });
});
