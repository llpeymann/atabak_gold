import { Injectable, Logger } from '@nestjs/common';

import { escapeHtml } from '../../common/html';
import { describeError, truncate } from '../../common/log-safety';
import { AppConfigService } from '../../config/app-config.service';
import { Keyboard } from '../../platform/platform.types';
import { PlatformAdapter } from '../../platform/platform-adapter';
import { User } from '../../users/user.types';
import {
  normalizeCustomerName,
  normalizeNotes,
  normalizeProductDescription,
} from '../../sales/lead-validation';
import { generateSubmissionKey } from '../../sales/lead-reference';
import { normalizePhone } from '../../sales/phone';
import {
  SALES_CONSENT_NOTICE_FA,
  SALES_CONSENT_TEXT_VERSION,
} from '../../sales/sales-consent';
import {
  categoryLabelFa,
  leadTimestampFa,
  STATUS_LABELS_FA,
} from '../../sales/sales-format';
import { SalesNotificationService } from '../../sales/sales-notification.service';
import { SalesService } from '../../sales/sales.service';
import { identityKeyOf } from '../../sales/sales.store';
import { LeadRecord, ProductCategory } from '../../sales/sales.types';
import { SalesCallbackAction } from '../ux/callback-data';
import { formatPriceScreen } from '../ux/ux-format';
import { MarketViewService } from '../ux/market-view.service';
import {
  salesBackKeyboard,
  salesConfirmKeyboard,
  SalesFormStep,
  salesFormKeyboard,
  salesHubKeyboard,
} from './sales-keyboards';
import { categoryDefinition } from '../../sales/sales.types';

/**
 * Phase 9 — the customer side of the Sales Engine, inside the existing bot (§2–§8).
 *
 * Responsibilities: render the purchase entry, run the (in-memory) form, validate input for immediate
 * feedback, call `SalesService` for the *durable* write and let `SalesNotificationService` own the
 * delivery of the confirmation. Two things it deliberately does **not** do:
 *
 *  * it never decides that a lead exists — the lead is reported as created only after the store
 *    confirmed the write, and the tracking code shown to the customer is the stored one;
 *  * it never touches market state: the reference price comes from `MarketViewService`, the read-only
 *    projection of the validated Phase 1 state (§4).
 */

/** One unfinished form per user, in memory only (an abandoned form expires, §7.4). */
interface SalesFormState {
  category: ProductCategory;
  step: SalesFormStep;
  customerName: string | null;
  phoneCanonical: string | null;
  phoneDisplay: string | null;
  productDescription: string | null;
  notes: string | null;
  /** Fixed for the whole form, so a double click on «تأیید» can never create a second lead (§7.3). */
  submissionKey: string;
  startedAt: number;
}

/**
 * A dash-only answer (`-`, `–`, `...`) counts as “no answer” for the optional fields: it is what
 * people type when they mean “nothing”, and storing it would put junk into the record.
 */
const SKIP_ANSWER = /^[-–—.\s]+$/u;

@Injectable()
export class SalesUxService {
  private readonly logger = new Logger(SalesUxService.name);
  private readonly forms = new Map<string, SalesFormState>();

  constructor(
    private readonly config: AppConfigService,
    private readonly sales: SalesService,
    private readonly notifications: SalesNotificationService,
    private readonly views: MarketViewService,
  ) {}

  /** The customer surface follows the master switch, so a disabled engine has no entry point. */
  get enabled(): boolean {
    return this.config.salesEnabled && this.sales.enabled;
  }

  /**
   * Customer-facing reason. The technical switch name is deliberately *not* shown here (customers do
   * not read configuration); the operator surface names the key instead (§16.2).
   */
  get disabledReason(): string | null {
    return this.enabled ? null : 'بخش خرید طلا در حال حاضر غیرفعال است.';
  }

  /** `/buy` is accepted as a text entry so the surface can be reached without the menu button. */
  owns(text: string): boolean {
    return text.trimStart().toLowerCase().startsWith('/buy');
  }

  // --- screens ----------------------------------------------------------------------------------

  /** Entry screen (`🛒 خرید طلا`): categories plus the tracking shortcut. */
  renderHub(): { text: string; keyboard: Keyboard } {
    return {
      text: [
        '🛒 <b>خرید طلا و سکه</b>',
        '',
        'دسته‌ای که به آن علاقه دارید را انتخاب کنید و درخواست <b>استعلام قیمت</b> ثبت کنید.',
        'کارشناسان طلای اتابک درخواست شما را بررسی می‌کنند و با شما تماس می‌گیرند.',
        '',
        'ℹ️ ثبت درخواست، به معنی ثبت سفارش یا رزرو نیست و قیمت قطعی را کارشناس اعلام می‌کند.',
      ].join('\n'),
      keyboard: salesHubKeyboard(),
    };
  }

  /**
   * Entry screen of the surface, whatever the state of the engine is: `🛒 خرید طلا` must always
   * answer something true instead of silently doing nothing (§16).
   */
  renderEntry(): { text: string; keyboard: Keyboard } {
    return this.enabled
      ? this.renderHub()
      : { text: this.disabledText(), keyboard: salesBackKeyboard() };
  }

  /**
   * Category screen with the **market reference** price of the validated Phase 1 state.
   *
   * The distinction between a reference price and the final price is stated explicitly, a stale or
   * missing price is reported as such (never hidden, never guessed), and the customer can continue
   * even when no price is available (§4.1, §4.2).
   */
  renderCategory(category: ProductCategory): {
    text: string;
    keyboard: Keyboard;
  } {
    const definition = categoryDefinition(category);
    const view = this.views.buildPriceListForSymbols(
      definition.referenceSymbols,
    );

    const priceBlock = formatPriceScreen(
      `قیمت مرجع ${definition.labelFa}`,
      view,
      this.config.displayUnit,
      {
        emptyText:
          'ℹ️ قیمت مرجع این دسته در حال حاضر در دسترس نیست؛ ثبت درخواست همچنان ممکن است.',
        includeSectionTitles: false,
      },
    );

    return {
      text: [
        `🏷 <b>${escapeHtml(definition.labelFa)}</b>`,
        '',
        definition.pricingNoteFa,
        '',
        priceBlock,
        '',
        '📝 برای ثبت درخواست استعلام، نام و نام خانوادگی خود را بنویسید:',
      ].join('\n'),
      keyboard: salesFormKeyboard('name'),
    };
  }

  // --- text input -------------------------------------------------------------------------------

  /**
   * Consume a plain message while the user is filling the form (§4.4).
   *
   * Returns `false` when the message is not part of a form: a command (or any unrelated text) then
   * follows the normal routing. Every value is validated *before* it is stored in the form state, so
   * the customer cannot walk into a confirmation screen with an impossible phone number.
   */
  async handleText(
    adapter: PlatformAdapter,
    user: User,
    text: string,
    chatId: string,
  ): Promise<boolean> {
    if (this.forms.size === 0) {
      return false;
    }

    const state = this.forms.get(user.id);

    if (!state) {
      return false;
    }

    // A command always leaves the form: an incomplete form never becomes a lead (§7.4).
    if (text.trimStart().startsWith('/')) {
      this.forms.delete(user.id);
      return false;
    }

    if (!this.enabled) {
      this.forms.delete(user.id);
      await this.send(
        adapter,
        user,
        chatId,
        this.disabledText(),
        salesBackKeyboard(),
      );
      return true;
    }

    if (this.expired(state)) {
      this.forms.delete(user.id);
      await this.send(
        adapter,
        user,
        chatId,
        '⌛️ فرم شما منقضی شد و اطلاعات نیمه‌کاره ثبت نشد. لطفاً از ابتدا شروع کنید.',
        salesBackKeyboard(),
      );
      return true;
    }

    switch (state.step) {
      case 'name': {
        const name = normalizeCustomerName(text);

        if (!name.ok) {
          await this.send(
            adapter,
            user,
            chatId,
            `⚠️ ${name.message}`,
            salesFormKeyboard('name'),
          );
          return true;
        }

        state.customerName = name.value;
        state.step = 'phone';
        await this.send(
          adapter,
          user,
          chatId,
          [
            '📱 شماره تماس خود را بنویسید.',
            '',
            'مثال: ۰۹۱۲۳۴۵۶۷۸۹ یا ۰۲۱۲۲۳۳۴۴۵۵',
            'ℹ️ این شماره فقط برای پیگیری همین درخواست استفاده می‌شود.',
          ].join('\n'),
          salesFormKeyboard('phone'),
        );
        return true;
      }

      case 'phone': {
        const phone = normalizePhone(text);

        if (!phone.ok) {
          await this.send(
            adapter,
            user,
            chatId,
            `⚠️ ${this.phoneErrorText(phone.reason)}`,
            salesFormKeyboard('phone'),
          );
          return true;
        }

        state.phoneCanonical = phone.value.canonical;
        state.phoneDisplay = phone.value.display;
        state.step = 'description';
        await this.send(
          adapter,
          user,
          chatId,
          [
            '📝 اگر محصول مشخصی مدنظر دارید، توضیح دهید.',
            '',
            `مثال: ${categoryDefinition(state.category).exampleItemsFa.join('، ')}`,
            'این توضیح اختیاری است؛ با دکمهٔ «بدون توضیح» یا فرستادن «-» می‌توانید رد کنید.',
          ].join('\n'),
          salesFormKeyboard('description'),
        );
        return true;
      }

      case 'description': {
        const description = SKIP_ANSWER.test(text.trim())
          ? ({ ok: true, value: null } as const)
          : normalizeProductDescription(text);

        if (!description.ok) {
          await this.send(
            adapter,
            user,
            chatId,
            `⚠️ ${description.message}`,
            salesFormKeyboard('description'),
          );
          return true;
        }

        state.productDescription = description.value;
        state.step = 'notes';
        await this.send(
          adapter,
          user,
          chatId,
          [
            '🗒 آیا یادداشت دیگری برای کارشناس دارید؟ (اختیاری)',
            'مثال: ساعت مناسب تماس، شهر، یا توضیح بیشتر دربارهٔ درخواست.',
            'ℹ️ برای رد کردن، دکمهٔ «بدون توضیح» را بزنید یا «-» بفرستید.',
          ].join('\n'),
          salesFormKeyboard('notes'),
        );
        return true;
      }

      case 'notes': {
        const notes = SKIP_ANSWER.test(text.trim())
          ? ({ ok: true, value: null } as const)
          : normalizeNotes(text);

        if (!notes.ok) {
          await this.send(
            adapter,
            user,
            chatId,
            `⚠️ ${notes.message}`,
            salesFormKeyboard('notes'),
          );
          return true;
        }

        state.notes = notes.value;
        state.step = 'confirm';
        await this.send(
          adapter,
          user,
          chatId,
          this.summaryText(state),
          salesConfirmKeyboard(),
        );
        return true;
      }

      case 'confirm':
      default:
        // The confirmation screen is answered with buttons, not with text: re-show it instead of
        // silently dropping what the customer typed.
        await this.send(
          adapter,
          user,
          chatId,
          this.summaryText(state),
          salesConfirmKeyboard(),
        );
        return true;
    }
  }

  // --- buttons ----------------------------------------------------------------------------------

  /** Handle one customer-side sales button. Authorization is irrelevant here: it is the user's own form. */
  async handleCallback(
    adapter: PlatformAdapter,
    user: User,
    callbackId: string,
    messageId: number | undefined,
    action: SalesCallbackAction,
  ): Promise<void> {
    const chatId = user.chatId ?? user.platformUserId;

    switch (action.kind) {
      case 'sales-hub': {
        this.forms.delete(user.id);
        const hub = this.renderHub();
        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          chatId,
          hub.text,
          hub.keyboard,
          messageId,
        );
        return;
      }

      case 'sales-category': {
        if (!this.enabled) {
          await adapter.acknowledge(callbackId, 'غیرفعال');
          await this.send(
            adapter,
            user,
            chatId,
            this.disabledText(),
            salesBackKeyboard(),
            messageId,
          );
          return;
        }

        // A new category always starts a *new* submission key: a different request is a new lead.
        this.forms.set(user.id, {
          category: action.category,
          step: 'name',
          customerName: null,
          phoneCanonical: null,
          phoneDisplay: null,
          productDescription: null,
          notes: null,
          submissionKey: generateSubmissionKey(),
          startedAt: Date.now(),
        });

        const screen = this.renderCategory(action.category);
        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          chatId,
          screen.text,
          screen.keyboard,
          messageId,
        );
        return;
      }

      case 'sales-skip-description': {
        const state = this.activeForm(user.id);

        if (!state) {
          await this.answerExpiredForm(
            adapter,
            user,
            chatId,
            callbackId,
            messageId,
          );
          return;
        }

        state.productDescription = null;
        state.step = 'notes';
        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          chatId,
          [
            '🗒 یادداشتی برای کارشناس دارید؟ (اختیاری)',
            'اگر ندارید، با دکمهٔ «بدون توضیح» رد کنید.',
          ].join('\n'),
          salesFormKeyboard('notes'),
          messageId,
        );
        return;
      }

      case 'sales-edit': {
        const state = this.activeForm(user.id);

        if (!state) {
          await this.answerExpiredForm(
            adapter,
            user,
            chatId,
            callbackId,
            messageId,
          );
          return;
        }

        // Correcting never creates a second lead: the same submission key is kept (§4.5).
        state.step = 'name';
        state.customerName = null;
        state.phoneCanonical = null;
        state.phoneDisplay = null;
        await adapter.acknowledge(callbackId, 'اصلاح اطلاعات');
        await this.send(
          adapter,
          user,
          chatId,
          '✏️ نام و نام خانوادگی خود را دوباره بنویسید:',
          salesFormKeyboard('name'),
          messageId,
        );
        return;
      }

      case 'sales-cancel': {
        this.forms.delete(user.id);
        const hub = this.renderHub();
        await adapter.acknowledge(callbackId, 'لغو شد');
        await this.send(
          adapter,
          user,
          chatId,
          ['❌ درخواست شما لغو شد و هیچ اطلاعاتی ثبت نشد.', '', hub.text].join(
            '\n',
          ),
          hub.keyboard,
          messageId,
        );
        return;
      }

      case 'sales-confirm': {
        await this.confirm(adapter, user, chatId, callbackId, messageId);
        return;
      }

      case 'sales-track': {
        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          chatId,
          this.trackingText(user),
          salesBackKeyboard(),
          messageId,
        );
        return;
      }

      default:
        // Every admin action is routed to the admin surface; a customer reaching this branch means a
        // button was forwarded, which changes nothing: the answer is the hub.
        await adapter.acknowledge(callbackId);
        await this.send(
          adapter,
          user,
          chatId,
          this.renderHub().text,
          salesHubKeyboard(),
          messageId,
        );
    }
  }

  /** Drop an unfinished form (a command, another screen, or an alert wizard takes over). */
  clearForm(userId: string): void {
    this.forms.delete(userId);
  }

  hasForm(userId: string): boolean {
    return this.forms.has(userId);
  }

  // --- internals --------------------------------------------------------------------------------

  private async confirm(
    adapter: PlatformAdapter,
    user: User,
    chatId: string,
    callbackId: string,
    messageId: number | undefined,
  ): Promise<void> {
    const state = this.activeForm(user.id);

    if (!state) {
      await this.answerExpiredForm(
        adapter,
        user,
        chatId,
        callbackId,
        messageId,
      );
      return;
    }

    if (!state.customerName || !state.phoneCanonical) {
      state.step = 'name';
      await adapter.acknowledge(callbackId, 'اطلاعات ناقص است');
      await this.send(
        adapter,
        user,
        chatId,
        '⚠️ اطلاعات فرم کامل نیست. لطفاً از نام شروع کنید.',
        salesFormKeyboard('name'),
        messageId,
      );
      return;
    }

    const phoneCanonical = state.phoneCanonical;
    const result = await this.sales.createLead({
      userId: user.id,
      identityKey: identityKeyOf(user.platform, user.platformUserId),
      platform: user.platform,
      platformUserId: user.platformUserId,
      chatId: user.chatId,
      customerName: state.customerName,
      phone: phoneCanonical,
      category: state.category,
      productDescription: state.productDescription,
      notes: state.notes,
      submissionKey: state.submissionKey,
      consentTextVersion: SALES_CONSENT_TEXT_VERSION,
    });

    if (!result.ok) {
      // Nothing is claimed to the customer: the form stays open and the same submission key is reused,
      // so a retry can never become a second lead.
      this.logger.error(
        `Lead submission failed for ${user.id} (${result.code}): ${truncate(result.message, 200)}`,
      );
      await adapter.acknowledge(callbackId, '❌ ثبت نشد');
      await this.send(
        adapter,
        user,
        chatId,
        `⚠️ ${result.message}`,
        salesConfirmKeyboard(),
        messageId,
      );
      if (result.code !== 'PERSISTENCE_FAILED') {
        this.forms.delete(user.id);
      }
      return;
    }

    const { lead, created } = result.value;
    this.forms.delete(user.id);

    // The lead exists now. Everything below is *delivery*: a failure here is logged and retried and
    // can never invalidate the stored request (§8.3).
    await adapter.acknowledge(
      callbackId,
      created ? '✅ درخواست ثبت شد' : '✅ درخواست شما قبلاً ثبت شده است',
    );

    try {
      await this.notifications.enqueueForLead({
        leadId: lead.leadId,
        platform: user.platform,
        customer: {
          userId: user.id,
          targetUserId: user.platformUserId,
          chatId: user.chatId,
        },
      });
      this.notifications.dispatchForLead(lead.leadId);
    } catch (error) {
      this.logger.error(
        `Lead ${lead.reference} was stored but its notifications could not be queued: ${describeError(error)}`,
      );
    }

    await this.send(
      adapter,
      user,
      chatId,
      [
        `✅ درخواست شما با کد پیگیری <b>${escapeHtml(lead.reference)}</b> ثبت شد.`,
        '',
        `🏷 دسته‌بندی: ${escapeHtml(categoryLabelFa(lead.category))}`,
        '📞 کارشناسان طلای اتابک در اولین فرصت کاری با شما تماس خواهند گرفت.',
        '📩 پیام تأییدیه نیز برای شما ارسال می‌شود.',
      ].join('\n'),
      salesBackKeyboard(),
      messageId,
    );
  }

  private summaryText(state: SalesFormState): string {
    const description =
      state.productDescription === null
        ? 'بدون توضیح محصول'
        : escapeHtml(state.productDescription);
    const notes = state.notes === null ? 'ندارد' : escapeHtml(state.notes);

    return [
      '🧾 <b>بازبینی درخواست</b>',
      '',
      `👤 نام: ${escapeHtml(state.customerName ?? '')}`,
      `📱 تماس: ${escapeHtml(state.phoneDisplay ?? '')}`,
      `🏷 دسته: ${escapeHtml(categoryLabelFa(state.category))}`,
      `📝 محصول: ${description}`,
      `🗒 یادداشت: ${notes}`,
      '',
      '⚠️ این درخواست، سفارش یا رزرو نیست؛ فقط برای دریافت قیمت و بررسی کارشناس است.',
      '',
      SALES_CONSENT_NOTICE_FA,
    ].join('\n');
  }

  private trackingText(user: User): string {
    const leads = this.sales.listLeadsByIdentity(
      identityKeyOf(user.platform, user.platformUserId),
    );

    if (leads.length === 0) {
      return [
        '🔎 <b>درخواست‌های من</b>',
        '',
        'هنوز درخواستی ثبت نکرده‌اید.',
        'برای ثبت درخواست استعلام قیمت، از منوی «🛒 خرید طلا» شروع کنید.',
      ].join('\n');
    }

    const lines = ['🔎 <b>درخواست‌های من</b>', ''];

    for (const lead of leads.slice(0, 5)) {
      lines.push(...this.trackRow(lead));
    }

    if (leads.length > 5) {
      lines.push('', 'ℹ️ فقط ۵ درخواست آخر نمایش داده می‌شود.');
    }

    lines.push('', 'برای پیگیری، کد درخواست را به کارشناس اعلام کنید.');
    return lines.join('\n');
  }

  private trackRow(lead: LeadRecord): string[] {
    return [
      `🆔 <b>${escapeHtml(lead.reference)}</b> — ${escapeHtml(STATUS_LABELS_FA[lead.status])}`,
      `   🏷 ${escapeHtml(categoryLabelFa(lead.category))} · 🕒 ${escapeHtml(leadTimestampFa(lead.createdAt))}`,
    ];
  }

  private disabledText(): string {
    return [
      '⚠️ بخش خرید طلا در حال حاضر در دسترس نیست.',
      this.disabledReason ?? '',
      '',
      'می‌توانید قیمت‌های لحظه‌ای بازار را از منوی اصلی ببینید.',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /** The active, non-expired form of one user; an expired form is dropped on the way out. */
  private activeForm(userId: string): SalesFormState | null {
    const state = this.forms.get(userId);

    if (!state) {
      return null;
    }

    if (this.expired(state)) {
      this.forms.delete(userId);
      return null;
    }

    return state;
  }

  private expired(state: SalesFormState): boolean {
    return Date.now() - state.startedAt > this.config.salesFormTtlMs;
  }

  private phoneErrorText(
    reason:
      'EMPTY' | 'INVALID_CHARACTERS' | 'INVALID_LENGTH' | 'UNSUPPORTED_PREFIX',
  ): string {
    switch (reason) {
      case 'EMPTY':
        return 'شماره تماس را وارد کنید.';
      case 'INVALID_CHARACTERS':
        return 'شماره تماس فقط می‌تواند رقم، فاصله، خط تیره و + داشته باشد.';
      case 'INVALID_LENGTH':
        return 'شماره تماس باید ۱۰ رقم (بدون کد کشور) باشد. مثال: ۰۹۱۲۳۴۵۶۷۸۹';
      case 'UNSUPPORTED_PREFIX':
      default:
        return 'این شماره با پیش‌شماره‌های ایران (۰۹… یا ۰۲۱…) هم‌خوان نیست. لطفاً شماره را بررسی کنید.';
    }
  }

  /** A button pressed after the form was dropped: explained, never silently ignored (§4.6). */
  private async answerExpiredForm(
    adapter: PlatformAdapter,
    user: User,
    chatId: string,
    callbackId: string,
    messageId: number | undefined,
  ): Promise<void> {
    const hub = this.renderHub();
    await adapter.acknowledge(callbackId, 'فرم منقضی شده');
    await this.send(
      adapter,
      user,
      chatId,
      [
        '⌛️ این فرم دیگر فعال نیست و اطلاعات نیمه‌کاره ثبت نشد.',
        'برای ثبت درخواست، از ابتدا شروع کنید:',
        '',
        hub.text,
      ].join('\n'),
      hub.keyboard,
      messageId,
    );
  }

  private async send(
    adapter: PlatformAdapter,
    user: User,
    chatId: string,
    text: string,
    keyboard: Keyboard,
    editMessageId?: number,
  ): Promise<void> {
    try {
      await adapter.render({
        chatId,
        text,
        keyboard,
        ...(typeof editMessageId === 'number' ? { editMessageId } : {}),
      });
    } catch (error) {
      // A failed render is logged and nothing else: the durable state (the lead) is untouched.
      this.logger.error(
        `Could not render the sales surface for ${user.id}: ${describeError(error)}`,
      );
    }
  }
}
