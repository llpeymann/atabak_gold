import { Logger } from '@nestjs/common';

import { tehranDayKey } from '../../common/tehran-time';
import { InboundUpdate } from '../../platform/platform.types';
import { createUxHarness, UxHarness } from '../../testing/test-doubles';
import { parseCallbackData } from '../ux/callback-data';
import {
  itemKeyboard,
  listKeyboard,
  parseContentCommand,
  tehranWallClockToIso,
  todayInTehran,
} from './content-admin.service';
import { ContentItem } from '../../channel/channel.types';

/**
 * §27.9 / §22 — the management surface.
 *
 * The surface is an extension of the existing bot and is gated by `CHANNEL_ADMIN_USER_IDS`; a
 * non-admin must not be able to create, approve, schedule or publish anything, and a button payload
 * only ever carries an internal content id (never an authorisation).
 */

const ADMIN = 'bale:100';
const OTHER = 'bale:200';

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  CHANNEL_ADMIN_USER_IDS: ADMIN,
  ...extra,
});

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

const item = (overrides: Partial<ContentItem> = {}): ContentItem => ({
  id: 'cnt_abc_123',
  messageType: 'EDUCATIONAL',
  title: 'عنوان',
  body: 'متن',
  mediaUrl: null,
  includeMarketData: false,
  revision: 1,
  status: 'DRAFT',
  createdAt: '2026-09-30T08:00:00.000Z',
  updatedAt: '2026-09-30T08:00:00.000Z',
  approvedAt: null,
  approvedBy: null,
  scheduledAt: null,
  reportingDate: null,
  lastJobId: null,
  cancelledAt: null,
  lastError: null,
  ...overrides,
});

describe('content surface — authorization (§22)', () => {
  let harness: UxHarness;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is disabled when the allow-list is empty', () => {
    harness = createUxHarness({ CHANNEL_ADMIN_USER_IDS: '' });

    expect(harness.channel.contentAdmin.enabled).toBe(false);
    expect(harness.channel.contentAdmin.isAdmin('bale', '100')).toBe(false);
  });

  it('answers a non-admin with the ordinary menu and creates nothing', async () => {
    harness = createUxHarness(env());

    await harness.botUx.handleUpdate(
      message('/content new EDUCATIONAL\nعنوان\nمتن آزمایشی', OTHER, 1),
    );

    expect(harness.channel.content.list()).toHaveLength(0);
    expect(harness.last().text).toContain('منوی اصلی');
    expect(harness.last().text).not.toContain('مدیریت محتوا');
  });

  it('rejects a button press from a non-admin without touching the content', async () => {
    harness = createUxHarness(env());
    const created = await harness.channel.content.create(
      { messageType: 'EDUCATIONAL', title: 't', body: 'b', authorId: ADMIN },
      new Date('2026-09-30T08:00:00.000Z'),
    );
    const id = created.ok ? created.content.id : '';

    await harness.botUx.handleUpdate({
      kind: 'callback',
      platform: 'bale',
      updateId: 2,
      platformUserId: OTHER.split(':')[1],
      chatId: '200',
      messageId: 5,
      callbackId: 'cb-1',
      data: `v1:c:apr:${id}`,
    } as unknown as InboundUpdate);

    expect(harness.channel.content.find(id)?.status).toBe('DRAFT');
    const acks = harness.platform.calls.filter((call) => call.kind === 'ack');
    expect(acks).toHaveLength(1);
    expect(acks[0].alertText).toBe('این بخش در دسترس نیست.');
  });

  it('accepts a platform-scoped admin id and rejects the same id on another platform', () => {
    harness = createUxHarness({ CHANNEL_ADMIN_USER_IDS: 'telegram:100' });

    expect(harness.channel.contentAdmin.isAdmin('telegram', '100')).toBe(true);
    expect(harness.channel.contentAdmin.isAdmin('bale', '100')).toBe(false);
  });
});

describe('content surface — commands (§27.9)', () => {
  let harness: UxHarness;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    harness = createUxHarness(env());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const adminId = (): string => ADMIN.split(':')[1];

  it('shows the overview to an admin', async () => {
    await harness.botUx.handleUpdate(message('/content', adminId(), 1));

    expect(harness.last().text).toContain('مدیریت محتوا');
  });

  it('creates a draft from a three-part command', async () => {
    await harness.botUx.handleUpdate(
      message(
        '/content new EDUCATIONAL\nقیمت‌گذاری طلا\nعیار و اجرت در قیمت نهایی مؤثرند.',
        adminId(),
        1,
      ),
    );

    const items = harness.channel.content.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      messageType: 'EDUCATIONAL',
      title: 'قیمت‌گذاری طلا',
      body: 'عیار و اجرت در قیمت نهایی مؤثرند.',
      status: 'DRAFT',
    });
    expect(items[0].approvedAt).toBeNull();
  });

  it('keeps multi-line bodies intact', async () => {
    await harness.botUx.handleUpdate(
      message(
        '/content new BRANDED\nعنوان برند\nخط اول\n\nخط دوم',
        adminId(),
        1,
      ),
    );

    expect(harness.channel.content.list()[0].body).toBe('خط اول\n\nخط دوم');
  });

  it('runs the full lifecycle from the chat: create → approve → publish', async () => {
    await harness.botUx.handleUpdate(
      message('/content new EDUCATIONAL\nعنوان\nمتن آموزشی', adminId(), 1),
    );
    const id = harness.channel.content.list()[0].id;

    await harness.botUx.handleUpdate(
      message(`/content approve ${id}`, adminId(), 2),
    );
    expect(harness.channel.content.find(id)?.status).toBe('APPROVED');

    await harness.botUx.handleUpdate(
      message(`/content publish ${id}`, adminId(), 3),
    );
    expect(harness.channel.content.find(id)?.status).toBe('PUBLISHED');
    expect(harness.channel.publishes()).toHaveLength(1);
    expect(harness.channel.publishes()[0].text).toContain('گنجینه طلایی اتابک');
  });

  it('schedules in Tehran wall-clock time and stores an absolute instant', async () => {
    await harness.botUx.handleUpdate(
      message('/content new BRANDED\nعنوان\nمتن', adminId(), 1),
    );
    const id = harness.channel.content.list()[0].id;
    await harness.botUx.handleUpdate(
      message(`/content approve ${id}`, adminId(), 2),
    );

    await harness.botUx.handleUpdate(
      message(`/content schedule ${id} 2026-10-01 09:30`, adminId(), 3),
    );

    // 09:30 Tehran = 06:00 UTC (fixed +03:30).
    expect(harness.channel.content.find(id)?.scheduledAt).toBe(
      '2026-10-01T06:00:00.000Z',
    );
    expect(harness.channel.content.find(id)?.status).toBe('SCHEDULED');
  });

  it('rejects a malformed schedule instead of guessing a time', async () => {
    await harness.botUx.handleUpdate(
      message('/content new BRANDED\nعنوان\nمتن', adminId(), 1),
    );
    const id = harness.channel.content.list()[0].id;

    await harness.botUx.handleUpdate(
      message(`/content schedule ${id} فردا صبح`, adminId(), 2),
    );

    expect(harness.channel.content.find(id)?.scheduledAt).toBeNull();
    expect(harness.last().text).toContain('YYYY-MM-DD HH:MM');
  });

  it('attaches and removes media', async () => {
    await harness.botUx.handleUpdate(
      message('/content new BRANDED\nعنوان\nمتن', adminId(), 1),
    );
    const id = harness.channel.content.list()[0].id;

    await harness.botUx.handleUpdate(
      message(
        `/content media ${id} https://cdn.example.test/a.png`,
        adminId(),
        2,
      ),
    );
    expect(harness.channel.content.find(id)?.mediaUrl).toBe(
      'https://cdn.example.test/a.png',
    );

    await harness.botUx.handleUpdate(
      message(`/content media ${id} -`, adminId(), 3),
    );
    expect(harness.channel.content.find(id)?.mediaUrl).toBeNull();
  });

  it('answers an invalid command with the help text, never with a crash', async () => {
    await harness.botUx.handleUpdate(
      message('/content nonsense', adminId(), 1),
    );

    expect(harness.last().text).toContain('دستور نامعتبر است');
  });

  it('does not leak the surface through the callback parser', () => {
    expect(parseCallbackData('v1:c:list')).toEqual({ kind: 'content-list' });
    expect(parseCallbackData('v1:c:view:cnt_1')).toEqual({
      kind: 'content-view',
      contentId: 'cnt_1',
    });
    expect(parseCallbackData('v1:c:apr:cnt_1')).toEqual({
      kind: 'content-approve',
      contentId: 'cnt_1',
    });
    // Anything that is not an internal id is refused before it can reach the store.
    expect(parseCallbackData('v1:c:apr:../../etc/passwd')).toBeNull();
    expect(parseCallbackData('v1:c:apr')).toBeNull();
    expect(parseCallbackData('v1:c:other:cnt_1')).toBeNull();
  });

  it('parses the command grammar deterministically', () => {
    expect(parseContentCommand('/content')).toEqual({ action: 'list' });
    expect(parseContentCommand('/content help')).toEqual({ action: 'help' });
    expect(parseContentCommand('/content show cnt_1')).toEqual({
      action: 'show',
      id: 'cnt_1',
    });
    expect(parseContentCommand('/content approve cnt_1 extra')).toEqual({
      action: 'invalid',
    });
    expect(
      parseContentCommand('/content new EDUCATIONAL\nعنوان\nمتن').action,
    ).toBe('new');
    expect(
      parseContentCommand('/content new PRICE_UPDATE\nعنوان\nمتن'),
    ).toEqual({
      action: 'invalid',
    });
    expect(
      parseContentCommand('/content new EDUCATIONAL\nonly a title'),
    ).toEqual({
      action: 'invalid',
    });
  });

  it('converts a Tehran wall clock to UTC without depending on the server time zone', () => {
    expect(tehranWallClockToIso('2026-10-01 09:30')).toBe(
      '2026-10-01T06:00:00.000Z',
    );
    expect(tehranWallClockToIso('2026-10-01T00:15')).toBe(
      '2026-09-30T20:45:00.000Z',
    );
    expect(tehranWallClockToIso('nonsense')).toBeNull();
    expect(todayInTehran(new Date('2026-09-30T20:30:00.000Z'))).toBe(
      tehranDayKey(new Date('2026-09-30T20:30:00.000Z')),
    );
  });
});

describe('content surface — buttons and callbacks (§27.9)', () => {
  let harness: UxHarness;
  const adminId = (): string => ADMIN.split(':')[1];

  const callback = (data: string, updateId: number): InboundUpdate =>
    ({
      kind: 'callback',
      platform: 'bale',
      updateId,
      platformUserId: adminId(),
      chatId: adminId(),
      messageId: 501,
      callbackId: `cb-${updateId}`,
      data,
    }) as unknown as InboundUpdate;

  const publish = async (text: string, updateId: number): Promise<void> => {
    await harness.botUx.handleUpdate(message(text, adminId(), updateId));
  };

  const lastAck = (): string | undefined =>
    [...harness.platform.calls].reverse().find((call) => call.kind === 'ack')
      ?.alertText;

  const newDraft = async (type = 'EDUCATIONAL'): Promise<string> => {
    await publish(
      `/content new ${type}\nعنوان آزمایشی\nمتن آزمایشی برای انتشار`,
      90,
    );
    const items = harness.channel.content.list();
    return items[items.length - 1].id;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    harness = createUxHarness(env());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows one item with the transitions its state allows', async () => {
    const id = await newDraft();

    await publish(`/content show ${id}`, 1);

    const buttons = harness.buttons().map((button) => button.text);

    expect(harness.last().text).toContain('عنوان آزمایشی');
    expect(harness.last().text).toContain(id);
    expect(buttons).toContain('✅ تأیید');
    expect(buttons).toContain('⛔ لغو');
    expect(buttons).not.toContain('🚀 انتشار فوری');
  });

  it('opens the list and an item through the inline buttons', async () => {
    const id = await newDraft();

    await harness.botUx.handleUpdate(callback('v1:c:list', 1));
    expect(harness.last().text).toContain('مدیریت محتوا');
    expect(harness.buttons().map((button) => button.callbackData)).toContain(
      `v1:c:view:${id}`,
    );

    await harness.botUx.handleUpdate(callback(`v1:c:view:${id}`, 2));
    expect(harness.last().text).toContain('متن آزمایشی برای انتشار');
    expect(lastAck()).toBeUndefined();
  });

  it('approves and then publishes through the buttons', async () => {
    const id = await newDraft();

    await harness.botUx.handleUpdate(callback(`v1:c:apr:${id}`, 1));
    expect(lastAck()).toBe('تأیید شد.');
    expect(harness.channel.content.find(id)?.status).toBe('APPROVED');

    await harness.botUx.handleUpdate(callback(`v1:c:pub:${id}`, 2));
    expect(lastAck()).toBe('منتشر شد.');
    expect(harness.channel.content.find(id)?.status).toBe('PUBLISHED');
    expect(harness.channel.publishes()).toHaveLength(1);
  });

  it('cancels through the button and refuses to publish afterwards', async () => {
    const id = await newDraft();

    await harness.botUx.handleUpdate(callback(`v1:c:can:${id}`, 1));
    expect(lastAck()).toBe('لغو شد.');
    expect(harness.channel.content.find(id)?.status).toBe('CANCELLED');

    await publish(`/content publish ${id}`, 2);
    expect(harness.last().text).toContain('منتشر نشد');
    expect(harness.last().text).toContain('PUBLICATION_CANCELLED');
    expect(harness.channel.publishes()).toHaveLength(0);
  });

  it('says explicitly when a duplicate publication was prevented', async () => {
    const id = await newDraft();
    await publish(`/content approve ${id}`, 1);
    await publish(`/content publish ${id}`, 2);
    const afterFirst = harness.channel.publishes().length;

    await publish(`/content publish ${id}`, 3);

    expect(harness.last().text).toContain('قبلاً منتشر شده است');
    expect(harness.last().text).toContain('پیام تکراری ارسال نشد');
    expect(harness.channel.publishes()).toHaveLength(afterFirst);
    expect(
      harness.channel.store.listJobs().filter((job) => job.contentId === id),
    ).toHaveLength(1);
  });

  it('reports why a draft cannot be published instead of pretending', async () => {
    const id = await newDraft();

    await publish(`/content publish ${id}`, 1);

    expect(harness.last().text).toContain('CONTENT_NOT_APPROVED');
    expect(harness.channel.publishes()).toHaveLength(0);
  });

  it('toggles the market-data block of an editorial item', async () => {
    const id = await newDraft('NIGHTLY_ANALYSIS');
    expect(harness.channel.content.find(id)?.includeMarketData).toBe(true);

    await publish(`/content market ${id} off`, 1);
    expect(harness.channel.content.find(id)?.includeMarketData).toBe(false);

    await publish(`/content market ${id} on`, 2);
    expect(harness.channel.content.find(id)?.includeMarketData).toBe(true);
  });

  it('reopens a cancelled item as a new revision that needs a fresh approval', async () => {
    const id = await newDraft();
    await publish(`/content approve ${id}`, 1);
    await publish(`/content cancel ${id}`, 2);

    await publish(`/content reopen ${id}`, 3);

    const item = harness.channel.content.find(id);
    expect(item?.status).toBe('DRAFT');
    expect(item?.revision).toBe(2);
    expect(item?.approvedAt).toBeNull();
  });

  it('answers with a clear message for an unknown id and for an invalid media url', async () => {
    await publish('/content show cnt_missing_1', 1);
    expect(harness.last().text).toContain('پیدا نشد');

    const id = await newDraft();
    await publish(`/content media ${id} not-a-url`, 2);
    expect(harness.last().text).toContain('ورودی نامعتبر');
    expect(harness.channel.content.find(id)?.mediaUrl).toBeNull();
  });

  it('prints the command list on /content help', async () => {
    await publish('/content help', 1);

    expect(harness.last().text).toContain('/content approve');
    expect(harness.last().text).toContain('/content schedule');
  });

  it('summarises a list that is longer than one screen', async () => {
    for (let index = 0; index < 12; index += 1) {
      await harness.channel.content.create(
        {
          messageType: 'EDUCATIONAL',
          title: `عنوان ${index}`,
          body: `متن شماره ${index}`,
          authorId: ADMIN,
        },
        new Date(),
      );
    }

    await publish('/content', 1);

    expect(harness.last().text).toContain('مورد دیگر نمایش داده نشد');
  });

  it('does not leak editorial content through an invalid callback payload', async () => {
    const id = await newDraft();

    await harness.botUx.handleUpdate(callback('v1:c:apr:../../etc/passwd', 1));

    expect(harness.channel.content.find(id)?.status).toBe('DRAFT');
    expect(harness.last().text).toContain('منوی اصلی');
  });
});

describe('content surface — buttons', () => {
  it('offers only the transitions that the state allows', () => {
    const draft = itemKeyboard(item({ status: 'DRAFT' }))
      .flat()
      .map((button) => button.text);
    const approved = itemKeyboard(item({ status: 'APPROVED' }))
      .flat()
      .map((button) => button.text);
    const published = itemKeyboard(item({ status: 'PUBLISHED' }))
      .flat()
      .map((button) => button.text);

    expect(draft).toContain('✅ تأیید');
    expect(draft).not.toContain('🚀 انتشار فوری');
    expect(approved).toContain('🚀 انتشار فوری');
    expect(published).not.toContain('⛔ لغو');
    expect(published).not.toContain('🚀 انتشار فوری');
  });

  it('builds a list keyboard with one button per item', () => {
    const keyboard = listKeyboard([
      item({ id: 'cnt_1' }),
      item({ id: 'cnt_2', status: 'SCHEDULED' }),
    ]);

    const buttons = keyboard.flat().map((button) => button.callbackData);
    expect(buttons).toContain('v1:c:view:cnt_1');
    expect(buttons).toContain('v1:c:view:cnt_2');
  });
});
