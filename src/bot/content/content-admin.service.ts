import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { escapeHtml } from '../../common/html';
import { describeError } from '../../common/log-safety';
import {
  tehranDateFa,
  tehranDayKey,
  tehranTimeFa,
} from '../../common/tehran-time';
import { Platform } from '../../platform/platform.types';
import { PlatformAdapter } from '../../platform/platform-adapter';
import { User } from '../../users/user.types';
import { ContentCallbackAction } from '../ux/callback-data';
import {
  callbackDataForBack,
  callbackDataForContentAction,
  callbackDataForContentList,
  callbackDataForContentView,
  callbackDataForHome,
} from '../ux/callback-data';
import { ContentService } from '../../channel/content.service';
import { ChannelEngineService } from '../../channel/channel-engine.service';
import { ContentItem, MessageType } from '../../channel/channel.types';
import { PILLAR_TITLES, specFor } from '../../channel/message-registry';
import { Keyboard, KeyboardRow } from '../../platform/platform.types';

/**
 * Phase 5 — the smallest possible management surface for editorial content (§22).
 *
 * It is an *extension of the existing bot*, not a new service and not a public API: the admin
 * speaks to the same bot the users speak to, and every entry point is gated by
 * `CHANNEL_ADMIN_USER_IDS` (an empty list disables the surface completely). Non-admins get the
 * ordinary menu — the existence of the surface is not revealed by an error message.
 *
 * Commands (all Persian-facing, `TYPE` ∈ EDUCATIONAL | BRANDED | NIGHTLY_ANALYSIS):
 *
 *   /content                                  list open items
 *   /content show <id>                        one item + action buttons
 *   /content new <TYPE>                       (title on the next line, body after it)
 *   /content media <id> <url|->                attach/remove an image
 *   /content market <id> on|off               append the validated market block (nightly)
 *   /content approve <id>
 *   /content schedule <id> YYYY-MM-DD HH:MM   Tehran wall clock
 *   /content publish <id>                     publish now (approval is re-checked)
 *   /content cancel <id>
 *   /content reopen <id>
 */

const TEHRAN_OFFSET_MINUTES = 3 * 60 + 30;
const MAX_LIST_ITEMS = 10;

interface ParsedContentCommand {
  action:
    | 'list'
    | 'show'
    | 'new'
    | 'media'
    | 'market'
    | 'approve'
    | 'schedule'
    | 'publish'
    | 'cancel'
    | 'reopen'
    | 'help'
    | 'invalid';
  type?: MessageType;
  id?: string;
  argument?: string;
  title?: string;
  body?: string;
}

/** Convert a Tehran wall-clock `YYYY-MM-DD HH:MM` to an absolute ISO instant (fixed +03:30). */
export function tehranWallClockToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(
    value.trim(),
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute] = match;
  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute) - TEHRAN_OFFSET_MINUTES,
  );

  return Number.isFinite(utcMs) ? new Date(utcMs).toISOString() : null;
}

@Injectable()
export class ContentAdminService {
  private readonly logger = new Logger(ContentAdminService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly content: ContentService,
    private readonly engine: ChannelEngineService,
  ) {}

  /** An empty allow-list disables the surface entirely. */
  get enabled(): boolean {
    return this.config.channelAdminUserIds.length > 0;
  }

  isAdmin(platform: Platform, platformUserId: string): boolean {
    if (!this.enabled) {
      return false;
    }

    const entries = this.config.channelAdminUserIds;

    // `platform:userId` entries are authoritative; a bare id matches on every platform (documented).
    return (
      entries.includes(`${platform}:${platformUserId}`) ||
      entries.includes(platformUserId)
    );
  }

  /** True when the message is addressed to the content surface at all. */
  owns(text: string): boolean {
    return text.trimStart().startsWith('/content');
  }

  /** Handle an admin command. Returns `false` when the sender is not an admin. */
  async handleCommand(
    adapter: PlatformAdapter,
    user: User,
    text: string,
  ): Promise<boolean> {
    if (!this.isAdmin(adapter.platform, user.platformUserId)) {
      this.logger.warn(
        `Non-admin (${adapter.platform}:${user.platformUserId}) tried the content surface.`,
      );

      return false;
    }

    const parsed = parseContentCommand(text);

    if (parsed.action === 'invalid') {
      await this.send(adapter, user, this.helpText('دستور نامعتبر است.'));
      return true;
    }

    switch (parsed.action) {
      case 'help':
        await this.send(adapter, user, this.helpText());
        return true;
      case 'list':
        await this.renderList(adapter, user);
        return true;
      case 'new':
        await this.handleNew(adapter, user, parsed);
        return true;
      case 'show':
        await this.renderItem(adapter, user, parsed.id ?? '');
        return true;
      case 'media':
        await this.handleMedia(adapter, user, parsed);
        return true;
      case 'market':
        await this.handleMarketFlag(adapter, user, parsed);
        return true;
      case 'approve':
        await this.handleApprove(adapter, user, parsed.id ?? '');
        return true;
      case 'schedule':
        await this.handleSchedule(adapter, user, parsed);
        return true;
      case 'publish':
        await this.handlePublish(adapter, user, parsed.id ?? '');
        return true;
      case 'cancel':
        await this.handleCancel(adapter, user, parsed.id ?? '');
        return true;
      default:
        await this.handleReopen(adapter, user, parsed.id ?? '');
        return true;
    }
  }

  /** Handle an inline button of the content surface. */
  async handleCallback(
    adapter: PlatformAdapter,
    user: User,
    callbackId: string,
    messageId: number | undefined,
    action: ContentCallbackAction,
  ): Promise<void> {
    if (!this.isAdmin(adapter.platform, user.platformUserId)) {
      // Single acknowledgement for this callback (the router delegates it to us): the surface is
      // never disclosed, and the button stops spinning.
      await adapter.acknowledge(callbackId, 'این بخش در دسترس نیست.');
      this.logger.warn(
        `Non-admin (${adapter.platform}:${user.platformUserId}) pressed a content button.`,
      );
      return;
    }

    switch (action.kind) {
      case 'content-list':
        await adapter.acknowledge(callbackId);
        await this.renderList(adapter, user, messageId);
        return;
      case 'content-view':
        await adapter.acknowledge(callbackId);
        await this.renderItem(adapter, user, action.contentId, messageId);
        return;
      case 'content-approve':
        await this.handleApprove(
          adapter,
          user,
          action.contentId,
          callbackId,
          messageId,
        );
        return;
      case 'content-cancel':
        await this.handleCancel(
          adapter,
          user,
          action.contentId,
          callbackId,
          messageId,
        );
        return;
      default:
        await this.handlePublish(
          adapter,
          user,
          action.contentId,
          callbackId,
          messageId,
        );
    }
  }

  // --- screens -----------------------------------------------------------------

  private async renderList(
    adapter: PlatformAdapter,
    user: User,
    messageId?: number,
  ): Promise<void> {
    const items = this.content.listOpen();

    if (items.length === 0) {
      await this.send(
        adapter,
        user,
        [
          '📝 <b>مدیریت محتوا</b>',
          '',
          'هیچ محتوای بازی وجود ندارد.',
          '',
          this.helpText(),
        ].join('\n'),
        listKeyboard(),
        messageId,
      );
      return;
    }

    const lines = ['📝 <b>مدیریت محتوا</b>', ''];

    for (const item of items.slice(0, MAX_LIST_ITEMS)) {
      const spec = specFor(item.messageType);
      lines.push(
        `▫️ <code>${escapeHtml(item.id)}</code> — ${escapeHtml(spec.labelFa)} ` +
          `[${escapeHtml(ContentService.statusLabel(item.status))}] r${item.revision}` +
          (item.scheduledAt === null
            ? ''
            : ` · ${escapeHtml(tehranDateFa(new Date(item.scheduledAt)))} ` +
              `${escapeHtml(tehranTimeFa(new Date(item.scheduledAt)))}`),
      );
    }

    if (items.length > MAX_LIST_ITEMS) {
      lines.push(
        '',
        `ℹ️ ${items.length - MAX_LIST_ITEMS} مورد دیگر نمایش داده نشد.`,
      );
    }

    lines.push(
      '',
      'برای مشاهدهٔ هر مورد: <code>/content show &lt;id&gt;</code>',
    );

    await this.send(
      adapter,
      user,
      lines.join('\n'),
      listKeyboard(items.slice(0, MAX_LIST_ITEMS)),
      messageId,
    );
  }

  private async renderItem(
    adapter: PlatformAdapter,
    user: User,
    id: string,
    messageId?: number,
  ): Promise<void> {
    const item = id === '' ? null : this.content.find(id);

    if (!item) {
      await this.send(
        adapter,
        user,
        '❌ این محتوا پیدا نشد.',
        listKeyboard(),
        messageId,
      );
      return;
    }

    await this.send(
      adapter,
      user,
      this.describeItem(item),
      itemKeyboard(item),
      messageId,
    );
  }

  private describeItem(item: ContentItem): string {
    const spec = specFor(item.messageType);
    const pillar = PILLAR_TITLES[item.messageType];

    return [
      `📝 <b>${escapeHtml(spec.labelFa)}</b>${pillar ? ` — ${escapeHtml(pillar)}` : ''}`,
      `🆔 <code>${escapeHtml(item.id)}</code> · r${item.revision} · ` +
        `${escapeHtml(ContentService.statusLabel(item.status))}`,
      `📅 تاریخ گزارش: ${item.reportingDate ?? '—'}`,
      item.scheduledAt === null
        ? '⏰ زمان‌بندی: —'
        : `⏰ زمان‌بندی: ${escapeHtml(tehranDateFa(new Date(item.scheduledAt)))} ` +
          `${escapeHtml(tehranTimeFa(new Date(item.scheduledAt)))}`,
      item.approvedAt === null
        ? '✅ تأیید: —'
        : `✅ تأیید: ${escapeHtml(tehranDateFa(new Date(item.approvedAt)))} ` +
          `${escapeHtml(tehranTimeFa(new Date(item.approvedAt)))}`,
      item.mediaUrl === null ? '🖼 رسانه: —' : '🖼 رسانه: دارد',
      `📊 داده بازار: ${item.includeMarketData ? 'بله' : 'خیر'}`,
      item.lastError === null ? '' : `⚠️ ${escapeHtml(item.lastError)}`,
      '',
      `🏷 <b>${escapeHtml(item.title || '(بدون عنوان)')}</b>`,
      '',
      escapeHtml(item.body),
      '',
      'دستورها: <code>/content approve|cancel|publish|schedule|media|market &lt;id&gt;</code>',
    ]
      .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
      .join('\n');
  }

  // --- command handlers --------------------------------------------------------

  private async handleNew(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedContentCommand,
  ): Promise<void> {
    const type = parsed.type;

    if (!type) {
      await this.send(adapter, user, this.helpText('نوع محتوا مشخص نیست.'));
      return;
    }

    const result = await this.content.create({
      messageType: type,
      title: parsed.title ?? '',
      body: parsed.body ?? '',
      authorId: `${adapter.platform}:${user.platformUserId}`,
      includeMarketData: type === 'NIGHTLY_ANALYSIS',
    });

    if (!result.ok) {
      await this.send(
        adapter,
        user,
        `❌ ${escapeHtml(this.explain(result.reason, result.detail))}`,
      );
      return;
    }

    await this.send(
      adapter,
      user,
      `✅ پیش‌نویس ساخته شد.\n\n${this.describeItem(result.content)}`,
      itemKeyboard(result.content),
    );
  }

  private async handleMedia(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedContentCommand,
  ): Promise<void> {
    const item = parsed.id === undefined ? null : this.content.find(parsed.id);

    if (!item) {
      await this.send(adapter, user, '❌ این محتوا پیدا نشد.');
      return;
    }

    const argument = (parsed.argument ?? '').trim();
    const result = await this.content.edit(item.id, {
      mediaUrl: argument === '' || argument === '-' ? null : argument,
    });

    await this.reportMutation(adapter, user, result, 'رسانه به‌روزرسانی شد.');
  }

  private async handleMarketFlag(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedContentCommand,
  ): Promise<void> {
    const item = parsed.id === undefined ? null : this.content.find(parsed.id);
    const argument = (parsed.argument ?? '').trim().toLowerCase();

    if (!item || (argument !== 'on' && argument !== 'off')) {
      await this.send(adapter, user, this.helpText('دستور نامعتبر است.'));
      return;
    }

    const result = await this.content.edit(item.id, {
      includeMarketData: argument === 'on',
    });

    await this.reportMutation(
      adapter,
      user,
      result,
      'تنظیم داده بازار به‌روزرسانی شد.',
    );
  }

  private async handleApprove(
    adapter: PlatformAdapter,
    user: User,
    id: string,
    callbackId?: string,
    messageId?: number,
  ): Promise<void> {
    const result = await this.content.approve(
      id,
      `${adapter.platform}:${user.platformUserId}`,
    );

    if (callbackId) {
      await adapter.acknowledge(
        callbackId,
        result.ok ? 'تأیید شد.' : 'انجام نشد.',
      );
    }

    await this.reportMutation(
      adapter,
      user,
      result,
      'محتوا تأیید شد.',
      messageId,
    );
  }

  private async handleSchedule(
    adapter: PlatformAdapter,
    user: User,
    parsed: ParsedContentCommand,
  ): Promise<void> {
    const item = parsed.id === undefined ? null : this.content.find(parsed.id);
    const iso = tehranWallClockToIso(parsed.argument ?? '');

    if (!item || iso === null) {
      await this.send(
        adapter,
        user,
        this.helpText(
          'زمان زمان‌بندی باید به شکل <code>YYYY-MM-DD HH:MM</code> و به وقت تهران باشد.',
        ),
      );
      return;
    }

    const result = await this.content.schedule(item.id, iso);

    await this.reportMutation(adapter, user, result, 'زمان‌بندی ثبت شد.');
  }

  private async handlePublish(
    adapter: PlatformAdapter,
    user: User,
    id: string,
    callbackId?: string,
    messageId?: number,
  ): Promise<void> {
    const outcome = await this.engine.publishContent(id, new Date());
    // The duplicate guard answers with the *existing* (already delivered) job: the message was not
    // sent again, and the operator must be able to see that instead of a bare "published" (§12).
    const duplicate = outcome.skipReason === 'DUPLICATE_PUBLICATION';

    if (callbackId) {
      await adapter.acknowledge(
        callbackId,
        duplicate
          ? 'قبلاً منتشر شده بود.'
          : outcome.status === 'PUBLISHED'
            ? 'منتشر شد.'
            : 'منتشر نشد.',
      );
    }

    const item = this.content.find(id);
    const delivered = outcome.deliveries
      .map(
        (delivery) =>
          `${delivery.platform}: ${delivery.status}${
            delivery.externalMessageId
              ? ` (#${delivery.externalMessageId})`
              : ''
          }`,
      )
      .join('\n');

    if (duplicate) {
      await this.send(
        adapter,
        user,
        `ℹ️ قبلاً منتشر شده است؛ پیام تکراری ارسال نشد.\n${escapeHtml(delivered)}`,
        item ? itemKeyboard(item) : listKeyboard(),
        messageId,
      );
      return;
    }

    if (outcome.status === 'PUBLISHED') {
      await this.send(
        adapter,
        user,
        `✅ منتشر شد.\n${escapeHtml(delivered)}`,
        item ? itemKeyboard(item) : listKeyboard(),
        messageId,
      );
      return;
    }

    await this.send(
      adapter,
      user,
      `❌ منتشر نشد — دلیل: <code>${escapeHtml(outcome.skipReason ?? outcome.status)}</code>`,
      item ? itemKeyboard(item) : listKeyboard(),
      messageId,
    );
  }

  private async handleCancel(
    adapter: PlatformAdapter,
    user: User,
    id: string,
    callbackId?: string,
    messageId?: number,
  ): Promise<void> {
    const result = await this.content.cancel(id);

    if (callbackId) {
      await adapter.acknowledge(
        callbackId,
        result.ok ? 'لغو شد.' : 'انجام نشد.',
      );
    }

    await this.reportMutation(
      adapter,
      user,
      result,
      'محتوا لغو شد.',
      messageId,
    );
  }

  private async handleReopen(
    adapter: PlatformAdapter,
    user: User,
    id: string,
  ): Promise<void> {
    const result = await this.content.reopen(id);

    await this.reportMutation(
      adapter,
      user,
      result,
      'محتوا به پیش‌نویس بازگشت.',
    );
  }

  // --- helpers -----------------------------------------------------------------

  private async reportMutation(
    adapter: PlatformAdapter,
    user: User,
    result: {
      ok: boolean;
      reason?: string;
      detail?: string;
      content?: ContentItem;
    },
    successText: string,
    messageId?: number,
  ): Promise<void> {
    if (!result.ok || !result.content) {
      await this.send(
        adapter,
        user,
        `❌ ${escapeHtml(this.explain(result.reason ?? 'INVALID_STATE', result.detail))}`,
        listKeyboard(),
        messageId,
      );
      return;
    }

    await this.send(
      adapter,
      user,
      `✅ ${escapeHtml(successText)}\n\n${this.describeItem(result.content)}`,
      itemKeyboard(result.content),
      messageId,
    );
  }

  private explain(reason: string, detail?: string): string {
    const meanings: Record<string, string> = {
      NOT_FOUND: 'این محتوا پیدا نشد.',
      INVALID_STATE: 'در وضعیت فعلی این کار مجاز نیست.',
      INVALID_INPUT: 'ورودی نامعتبر است.',
      LIMIT_REACHED: 'به سقف تعداد رسیده‌اید.',
      NOT_AUTHORIZED: 'دسترسی ندارید.',
    };

    return `${meanings[reason] ?? 'انجام نشد.'}${detail ? ` (${detail})` : ''}`;
  }

  private helpText(prefix?: string): string {
    return [
      prefix ? `⚠️ ${prefix}` : '📝 <b>مدیریت محتوا</b>',
      '',
      '<code>/content</code> — فهرست موارد باز',
      '<code>/content show &lt;id&gt;</code>',
      '<code>/content new &lt;EDUCATIONAL|BRANDED|NIGHTLY_ANALYSIS&gt;</code>',
      '   خط دوم: عنوان، خطوط بعد: متن',
      '<code>/content media &lt;id&gt; &lt;url|-&gt;</code>',
      '<code>/content market &lt;id&gt; on|off</code>',
      '<code>/content approve &lt;id&gt;</code>',
      '<code>/content schedule &lt;id&gt; YYYY-MM-DD HH:MM</code>',
      '<code>/content publish &lt;id&gt;</code>',
      '<code>/content cancel &lt;id&gt;</code>',
      '<code>/content reopen &lt;id&gt;</code>',
      '',
      'اصل طلایی: هیچ محتوایی بدون تأیید منتشر نمی‌شود و هر ویرایش ویرایش‌ی مهم، تأیید را باطل می‌کند.',
    ].join('\n');
  }

  private async send(
    adapter: PlatformAdapter,
    user: User,
    text: string,
    keyboard?: Keyboard,
    editMessageId?: number,
  ): Promise<void> {
    try {
      await adapter.render({
        chatId: user.chatId ?? user.platformUserId,
        text,
        keyboard: keyboard ?? listKeyboard(),
        ...(typeof editMessageId === 'number' ? { editMessageId } : {}),
      });
    } catch (error) {
      this.logger.error(
        `Could not send the content screen: ${describeError(error)}`,
      );
    }
  }
}

/** Buttons of the item screen, depending on the item's state. */
export function itemKeyboard(item: ContentItem): Keyboard {
  const approve: KeyboardRow[] =
    item.status === 'DRAFT' || item.status === 'APPROVED'
      ? [
          [
            {
              text: '✅ تأیید',
              callbackData: callbackDataForContentAction('apr', item.id),
            },
          ],
        ]
      : [];
  const publish: KeyboardRow[] =
    item.status === 'APPROVED' ||
    item.status === 'SCHEDULED' ||
    item.status === 'FAILED'
      ? [
          [
            {
              text: '🚀 انتشار فوری',
              callbackData: callbackDataForContentAction('pub', item.id),
            },
          ],
        ]
      : [];
  const cancel: KeyboardRow[] =
    item.status !== 'PUBLISHED' && item.status !== 'CANCELLED'
      ? [
          [
            {
              text: '⛔ لغو',
              callbackData: callbackDataForContentAction('can', item.id),
            },
          ],
        ]
      : [];

  return [
    ...approve,
    ...publish,
    ...cancel,
    [
      { text: '📝 فهرست', callbackData: callbackDataForContentList() },
      { text: '🏠 خانه', callbackData: callbackDataForHome() },
      { text: '🔙 بازگشت', callbackData: callbackDataForBack() },
    ],
  ];
}

export function listKeyboard(items: readonly ContentItem[] = []): Keyboard {
  return [
    ...items.map<KeyboardRow>((item) => [
      {
        text: `${specFor(item.messageType).labelFa} · ${ContentService.statusLabel(item.status)}`,
        callbackData: callbackDataForContentView(item.id),
      },
    ]),
    [
      { text: '🏠 خانه', callbackData: callbackDataForHome() },
      { text: '🔙 بازگشت', callbackData: callbackDataForBack() },
    ],
  ];
}

/**
 * Parse `/content …`.
 *
 * The `new` form is deliberately line-based: the first line carries the command and the type, the
 * second line the title, every following line the body — so the body may contain any punctuation
 * (including the `|` that a one-line syntax would have to forbid).
 */
export function parseContentCommand(text: string): ParsedContentCommand {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = lines[0]?.trim() ?? '';
  const tokens = head.split(/\s+/);
  const [, sub, ...rest] = tokens;

  if (sub === undefined || sub === '') {
    return { action: 'list' };
  }

  switch (sub) {
    case 'help':
      return { action: 'help' };
    case 'list':
      return { action: 'list' };
    case 'show':
    case 'approve':
    case 'publish':
    case 'cancel':
    case 'reopen': {
      const [id, ...extra] = rest;

      if (!isContentIdToken(id) || extra.length > 0) {
        return { action: 'invalid' };
      }

      return { action: sub, id };
    }
    case 'media': {
      const [id, ...urlParts] = rest;

      if (!isContentIdToken(id)) {
        return { action: 'invalid' };
      }

      return { action: 'media', id, argument: urlParts.join(' ') };
    }
    case 'market': {
      const [id, flag, ...extra] = rest;

      if (!isContentIdToken(id) || flag === undefined || extra.length > 0) {
        return { action: 'invalid' };
      }

      return { action: 'market', id, argument: flag };
    }
    case 'schedule': {
      const id = rest[0];
      const argument = rest.slice(1).join(' ').trim();

      if (!isContentIdToken(id) || argument === '') {
        return { action: 'invalid' };
      }

      return { action: 'schedule', id, argument };
    }
    case 'new': {
      const [type, ...extra] = rest;

      if (
        extra.length > 0 ||
        type === undefined ||
        !isEditorialTypeToken(type)
      ) {
        return { action: 'invalid' };
      }

      const title = lines[1]?.trim() ?? '';
      const body = lines.slice(2).join('\n').trim();

      if (title === '' || body === '') {
        return { action: 'invalid' };
      }

      return { action: 'new', type: type as MessageType, title, body };
    }
    default:
      return { action: 'invalid' };
  }
}

function isContentIdToken(value: string | undefined): value is string {
  return typeof value === 'string' && /^cnt_[a-z0-9_]{1,40}$/.test(value);
}

function isEditorialTypeToken(value: string): boolean {
  return (
    value === 'EDUCATIONAL' ||
    value === 'BRANDED' ||
    value === 'NIGHTLY_ANALYSIS'
  );
}

/** Tehran reporting day of "now" — used by tests and the admin screens. */
export function todayInTehran(now: Date): string {
  return tehranDayKey(now);
}
