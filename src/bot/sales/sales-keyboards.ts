import { Keyboard, KeyboardButton } from '../../platform/platform.types';
import { formatNumberFa } from '../../common/money';
import { PRODUCT_CATEGORIES } from '../../sales/sales.types';
import {
  callbackDataForHome,
  callbackDataForSalesCancel,
  callbackDataForSalesCategory,
  callbackDataForSalesConfirm,
  callbackDataForSalesEdit,
  callbackDataForSalesHub,
  callbackDataForSalesLeadAssign,
  callbackDataForSalesLeadAssignTo,
  callbackDataForSalesLeadContact,
  callbackDataForSalesLeadConvert,
  callbackDataForSalesLeadConvertConfirm,
  callbackDataForSalesLeadHistory,
  callbackDataForSalesLeadLossMenu,
  callbackDataForSalesLeadLost,
  callbackDataForSalesLeadNote,
  callbackDataForSalesLeadSale,
  callbackDataForSalesLeadSaleNote,
  callbackDataForSalesLeadStatus,
  callbackDataForSalesLeadView,
  callbackDataForSalesList,
  callbackDataForSalesSkipDescription,
  callbackDataForSalesTrack,
} from '../ux/callback-data';
import { LOSS_REASON_LABELS_FA } from '../../sales/sales-format';
import {
  canTransition,
  LeadRecord,
  LOSS_REASONS,
} from '../../sales/sales.types';

/**
 * Phase 9 — keyboards of the sales surface.
 *
 * They live next to the sales handlers (the same way the campaign dashboard owns its keyboards) so
 * the *whole* customer and operator surface of this phase is reviewable in one place. Every button
 * carries a validated token only: no role, no price, no personal data (§15.3).
 */

/** Entry point of the customer flow: one row per category, plus tracking and the way back. */
export function salesHubKeyboard(): Keyboard {
  const rows: KeyboardButton[][] = [];
  let pending: KeyboardButton[] = [];

  for (const definition of PRODUCT_CATEGORIES) {
    pending.push({
      text: definition.labelFa,
      callbackData: callbackDataForSalesCategory(definition.category),
    });

    // Two categories per row keeps the labels readable on a phone.
    if (pending.length === 2) {
      rows.push(pending);
      pending = [];
    }
  }

  if (pending.length > 0) {
    rows.push(pending);
  }

  rows.push([
    {
      text: '🔎 پیگیری درخواست‌های من',
      callbackData: callbackDataForSalesTrack(),
    },
  ]);
  rows.push([{ text: '🏠 منوی اصلی', callbackData: callbackDataForHome() }]);

  return rows;
}

/** Every step of the form can be abandoned; only the description step can be skipped forward. */
export function salesFormKeyboard(step: SalesFormStep): Keyboard {
  const rows: KeyboardButton[][] = [];

  if (step === 'description' || step === 'notes') {
    rows.push([
      {
        text: '⏭ بدون توضیح، ادامه',
        callbackData: callbackDataForSalesSkipDescription(),
      },
    ]);
  }

  rows.push([
    { text: '❌ لغو درخواست', callbackData: callbackDataForSalesCancel() },
  ]);
  rows.push([{ text: '🏠 منوی اصلی', callbackData: callbackDataForHome() }]);

  return rows;
}

export type SalesFormStep =
  'name' | 'phone' | 'description' | 'notes' | 'confirm';

/**
 * The confirmation screen: submit, correct, cancel (§4.5). The three actions are exactly the ones the
 * specification asks for, and none of them is reachable from anywhere else.
 */
export function salesConfirmKeyboard(): Keyboard {
  return [
    [
      {
        text: '✅ تأیید و ثبت درخواست',
        callbackData: callbackDataForSalesConfirm(),
      },
    ],
    [
      { text: '✏️ اصلاح اطلاعات', callbackData: callbackDataForSalesEdit() },
      { text: '❌ لغو درخواست', callbackData: callbackDataForSalesCancel() },
    ],
    [{ text: '🏠 منوی اصلی', callbackData: callbackDataForHome() }],
  ];
}

/** Sending the customer back into the flow from a stale screen always works. */
export function salesBackKeyboard(): Keyboard {
  return [
    [{ text: '🛒 خرید طلا', callbackData: callbackDataForSalesHub() }],
    [{ text: '🏠 منوی اصلی', callbackData: callbackDataForHome() }],
  ];
}

// --- admin (lead management) surface ------------------------------------------------------------

export function salesAdminListKeyboard(
  leads: readonly LeadRecord[],
  page: number,
  pages: number,
): Keyboard {
  const rows: KeyboardButton[][] = leads.map((lead) => [
    {
      text: `🔎 ${lead.reference} · ${lead.customerName}`.slice(0, 60),
      callbackData: callbackDataForSalesLeadView(lead.leadId),
    },
  ]);

  const navigation: KeyboardButton[] = [];

  if (page > 1) {
    navigation.push({
      text: '◀️ قبلی',
      callbackData: callbackDataForSalesList(page - 1),
    });
  }

  if (page < pages) {
    navigation.push({
      text: `بعدی (${formatNumberFa(page + 1)}/${formatNumberFa(pages)}) ▶️`,
      callbackData: callbackDataForSalesList(page + 1),
    });
  }

  if (navigation.length > 0) {
    rows.push(navigation);
  }

  rows.push([
    { text: '🔁 به‌روزرسانی', callbackData: callbackDataForSalesList(page) },
  ]);
  rows.push([{ text: '🏠 منوی اصلی', callbackData: callbackDataForHome() }]);

  return rows;
}

/**
 * Actions available on one lead. Only transitions that the state machine allows from the current
 * status are offered — the button set is therefore a *hint*, and the service still re-validates the
 * transition when the button is pressed (§10.2).
 */
export function salesAdminLeadKeyboard(lead: LeadRecord): Keyboard {
  const rows: KeyboardButton[][] = [];
  const statuses: KeyboardButton[] = [];

  for (const target of ['NEW', 'CONTACTED', 'QUALIFIED'] as const) {
    if (canTransition(lead.status, target) && target !== lead.status) {
      statuses.push({
        text: `➡️ ${STATUS_BUTTON_LABELS[target]}`,
        callbackData: callbackDataForSalesLeadStatus(lead.leadId, target),
      });
    }
  }

  if (statuses.length > 0) {
    rows.push(statuses);
  }

  rows.push([
    {
      text: '📞 ثبت تماس',
      callbackData: callbackDataForSalesLeadContact(lead.leadId),
    },
    {
      text: '🗒 یادداشت',
      callbackData: callbackDataForSalesLeadNote(lead.leadId),
    },
  ]);

  if (canTransition(lead.status, 'CONVERTED')) {
    rows.push([
      {
        text: '✅ تبدیل به مشتری',
        callbackData: callbackDataForSalesLeadConvert(lead.leadId),
      },
    ]);
  }

  if (lead.status === 'CONVERTED') {
    rows.push([
      {
        text: '🛒 ثبت فروش',
        callbackData: callbackDataForSalesLeadSale(lead.leadId),
      },
      {
        text: '🛒 ثبت فروش بدون مبلغ',
        callbackData: callbackDataForSalesLeadSaleNote(lead.leadId),
      },
    ]);
  }

  if (canTransition(lead.status, 'LOST')) {
    rows.push([
      {
        text: '❌ از دست رفت',
        callbackData: callbackDataForSalesLeadLossMenu(lead.leadId),
      },
    ]);
  }

  rows.push([
    {
      text: '👤 واگذاری',
      callbackData: callbackDataForSalesLeadAssign(lead.leadId),
    },
    {
      text: '🕘 تاریخچه',
      callbackData: callbackDataForSalesLeadHistory(lead.leadId),
    },
  ]);

  rows.push([
    { text: '🔁 بازگشت به فهرست', callbackData: callbackDataForSalesList(1) },
  ]);
  rows.push([{ text: '🏠 منوی اصلی', callbackData: callbackDataForHome() }]);

  return rows;
}

/** Loss reasons, so `LOST` is always a documented reason and never a free-form status (§10.1). */
export function salesAdminLossKeyboard(leadId: string): Keyboard {
  const rows: KeyboardButton[][] = [];

  for (const reason of LOSS_REASONS) {
    rows.push([
      {
        text: LOSS_REASON_LABELS_FA[reason],
        callbackData: callbackDataForSalesLeadLost(leadId, reason),
      },
    ]);
  }

  rows.push([
    {
      text: '↩️ بازگشت به درخواست',
      callbackData: callbackDataForSalesLeadView(leadId),
    },
  ]);

  return rows;
}

/** Conversion is a money-affecting action: it needs an explicit second press (§10.5). */
export function salesAdminConvertConfirmKeyboard(leadId: string): Keyboard {
  return [
    [
      {
        text: '✅ بله، مشتری شد',
        callbackData: callbackDataForSalesLeadConvertConfirm(leadId),
      },
    ],
    [{ text: '↩️ انصراف', callbackData: callbackDataForSalesLeadView(leadId) }],
  ];
}

/** Assignment targets: the configured admin allow-list, referenced by index (never by payload role). */
export function salesAdminAssignKeyboard(
  leadId: string,
  adminIds: readonly string[],
): Keyboard {
  const rows: KeyboardButton[][] = adminIds.slice(0, 8).map((entry, index) => [
    {
      text: `👤 ${entry}`.slice(0, 60),
      callbackData: callbackDataForSalesLeadAssignTo(leadId, index),
    },
  ]);

  rows.push([
    {
      text: '↩️ بازگشت به درخواست',
      callbackData: callbackDataForSalesLeadView(leadId),
    },
  ]);

  return rows;
}

export function salesAdminHistoryKeyboard(leadId: string): Keyboard {
  return [
    [
      {
        text: '↩️ بازگشت به درخواست',
        callbackData: callbackDataForSalesLeadView(leadId),
      },
    ],
  ];
}

/** Back to the previous screen (used where no lead context exists). */
export function salesAdminListOnlyKeyboard(): Keyboard {
  return [
    [
      {
        text: '🔁 فهرست درخواست‌ها',
        callbackData: callbackDataForSalesList(1),
      },
    ],
    [{ text: '🏠 منوی اصلی', callbackData: callbackDataForHome() }],
  ];
}

const STATUS_BUTTON_LABELS = {
  NEW: 'جدید',
  CONTACTED: 'تماس گرفته‌شده',
  QUALIFIED: 'بررسی‌شده',
} as const;
