import { Keyboard, KeyboardRow } from '../../platform/platform.types';
import { FavoritesManageView } from './ux-view.types';
import {
  callbackDataForAlertCancel,
  callbackDataForAlertConfirm,
  callbackDataForAlertDelete,
  callbackDataForAlertDeleteConfirm,
  callbackDataForAlertEdit,
  callbackDataForAlertList,
  callbackDataForAlertNew,
  callbackDataForAlertStatus,
  callbackDataForAlertSymbol,
  callbackDataForAlertType,
  callbackDataForAlertView,
  callbackDataForBack,
  callbackDataForFavorite,
  callbackDataForHome,
  callbackDataForManageFavorites,
  callbackDataForScreen,
  ScreenKey,
} from './callback-data';
import { AlertStatus } from '../../alerts/alert.types';
import { SymbolDefinition } from '../../market/symbols';

/**
 * Keyboards (pure builders).
 *
 * Navigation is button-driven (§7, §44): every screen exposes a way back and a way home, so no
 * screen becomes a dead end (§8). Buttons carry only versioned callback data or a URL.
 */

const SECTION_EMOJI: Record<string, string> = {
  gold: '🟡',
  coins: '🪙',
  currency: '💵',
};

/**
 * Main menu of the bot.
 *
 * Phase 7 adds exactly one row (`👥 دعوت از دوستان`) and only when the growth engine is enabled —
 * the entry point is *inside* the existing menu, never a second menu or a replacement of one (§9.1).
 */
export function mainMenuKeyboard(
  options: { referral?: boolean } = {},
): Keyboard {
  return [
    [{ text: '💰 قیمت لحظهای', callbackData: callbackDataForScreen('prices') }],
    [
      { text: '🟡 طلا', callbackData: callbackDataForScreen('gold') },
      { text: '🪙 سکه', callbackData: callbackDataForScreen('coins') },
    ],
    [
      { text: '📊 بازار', callbackData: callbackDataForScreen('market') },
      { text: '🔔 هشدار', callbackData: callbackDataForScreen('alerts') },
    ],
    [
      {
        text: '⭐ علاقهمندیها',
        callbackData: callbackDataForScreen('favorites'),
      },
    ],
    ...(options.referral
      ? [
          [
            {
              text: '👥 دعوت از دوستان',
              callbackData: callbackDataForScreen('referral'),
            },
          ],
        ]
      : []),
    [
      {
        text: '📢 کانال اتابک',
        callbackData: callbackDataForScreen('channel'),
      },
    ],
  ];
}

/**
 * Shared footer of every inner screen.
 * `refreshScreen` re-renders the current screen from the *existing* market state — it never
 * triggers an external fetch (§23).
 */
export function screenFooter(
  options: { refreshScreen?: ScreenKey } = {},
): Keyboard {
  const refreshRow = options.refreshScreen
    ? [
        [
          {
            text: '↻ بروزرسانی',
            callbackData: callbackDataForScreen(options.refreshScreen),
          },
        ],
      ]
    : [];

  return [
    ...refreshRow,
    [
      { text: '⬅️ بازگشت', callbackData: callbackDataForBack() },
      { text: '🏠 منوی اصلی', callbackData: callbackDataForHome() },
    ],
  ];
}

export function pricesKeyboard(): Keyboard {
  return screenFooter({ refreshScreen: 'prices' });
}

export function sectionKeyboard(screen: ScreenKey): Keyboard {
  return screenFooter({ refreshScreen: screen });
}

/**
 * Phase 4 — hub of the market section (`📊 بازار`).
 *
 * The buttons only open other read-only screens; the refresh button re-renders the hub from the
 * already-validated state and never asks the provider for a new price (§29, §43).
 */
export function marketKeyboard(): Keyboard {
  return [
    [
      { text: '📊 گزارش امروز', callbackData: callbackDataForScreen('report') },
      {
        text: '📈 حرکت بازار',
        callbackData: callbackDataForScreen('movement'),
      },
    ],
    [
      {
        text: '🕐 آخرین بروزرسانی',
        callbackData: callbackDataForScreen('last-update'),
      },
    ],
    ...screenFooter({ refreshScreen: 'market' }),
  ];
}

/** Detailed report (`📋 گزارش کامل`) — same data as the daily report, one line per field. */
export function fullReportKeyboard(): Keyboard {
  return [
    [{ text: '📊 گزارش خلاصه', callbackData: callbackDataForScreen('report') }],
    ...screenFooter({ refreshScreen: 'report-full' }),
  ];
}

/** Compact daily report (`📊 گزارش امروز`) with the way to the detailed view. */
export function dailyReportKeyboard(): Keyboard {
  return [
    [
      {
        text: '📋 گزارش کامل',
        callbackData: callbackDataForScreen('report-full'),
      },
    ],
    ...screenFooter({ refreshScreen: 'report' }),
  ];
}

export function menuKeyboard(options: { referral?: boolean } = {}): Keyboard {
  return [
    ...mainMenuKeyboard(options),
    [{ text: '🏠 منوی اصلی', callbackData: callbackDataForHome() }],
  ];
}

export function expiredCallbackKeyboard(): Keyboard {
  return [[{ text: '🏠 منوی اصلی', callbackData: callbackDataForHome() }]];
}

export function favoritesKeyboard(): Keyboard {
  return [
    [
      {
        text: '⚙️ مدیریت علاقهمندیها',
        callbackData: callbackDataForManageFavorites(),
      },
    ],
    ...screenFooter({ refreshScreen: 'favorites' }),
  ];
}

/**
 * The referral screen footer.
 *
 * * `shareLink` is a URL button that opens the platform's share sheet (a documented capability of
 *   both platforms) — only when a link exists, so no dead button is ever rendered;
 * * with no link configured the row is omitted entirely (the screen shows a <code> block with the
 *   bot address instead of a button that cannot work) — no fabricated or placeholder URL, ever.
 */
export function referralKeyboard(link: string | null): Keyboard {
  return [
    ...(link ? [[{ text: '🔗 اشتراک‌گذاری لینک دعوت', url: link }]] : []),
    ...screenFooter({ refreshScreen: 'referral' }),
  ];
}

export function channelKeyboard(url: string | null): Keyboard {
  return [
    ...(url ? [[{ text: '📢 عضویت در کانال اتابک', url }]] : []),
    ...screenFooter(),
  ];
}

/** Toggle list for favorites management: `☑` selected, `☐` not selected. */
export function favoritesManageKeyboard(view: FavoritesManageView): Keyboard {
  const rows = view.options.map((option) => [
    {
      text: `${option.selected ? '☑' : '☐'} ${
        SECTION_EMOJI[option.section] ?? ''
      } ${option.label}`.trim(),
      callbackData: callbackDataForFavorite(
        option.selected ? 'remove' : 'add',
        option.symbol,
      ),
    },
  ]);

  return [...rows, ...screenFooter()];
}

// --- Phase 3: alerts ---------------------------------------------------------

/**
 * Alert hub (§23): create, list, and the usual way back. The main menu still owns the
 * `🔔 هشدار` entry point, so no second navigation system is introduced.
 */
export function alertsKeyboard(): Keyboard {
  return [
    [
      { text: '➕ ساخت هشدار', callbackData: callbackDataForAlertNew() },
      { text: '🔔 هشدارهای من', callbackData: callbackDataForAlertList() },
    ],
    ...screenFooter(),
  ];
}

/** Symbol picker of the wizard — only symbols that exist in the canonical registry (§21/§25). */
export function alertSymbolKeyboard(
  definitions: readonly SymbolDefinition[],
): Keyboard {
  const rows = definitions.map((definition) => [
    {
      text: `${
        definition.section === 'gold'
          ? '🟡'
          : definition.section === 'coins'
            ? '🪙'
            : '💵'
      } ${definition.label}`.trim(),
      callbackData: callbackDataForAlertSymbol(definition.symbol),
    },
  ]);

  return [...rows, ...screenFooter()];
}

/** Alert type picker: the two absolute conditions and the two percentage directions (§26). */
export function alertTypeKeyboard(): Keyboard {
  return [
    [
      {
        text: '📈 رسیدن به قیمت بالاتر',
        callbackData: callbackDataForAlertType('above'),
      },
    ],
    [
      {
        text: '📉 افت به قیمت پایین‌تر',
        callbackData: callbackDataForAlertType('below'),
      },
    ],
    [
      {
        text: '📈 افزایش درصدی',
        callbackData: callbackDataForAlertType('up'),
      },
      {
        text: '📉 کاهش درصدی',
        callbackData: callbackDataForAlertType('down'),
      },
    ],
    ...screenFooter(),
  ];
}

/** Target input step: the user types a number, the wizard consumes the next message. */
export function alertTargetInputKeyboard(): Keyboard {
  return [
    [{ text: '❌ لغو', callbackData: callbackDataForAlertCancel() }],
    ...screenFooter(),
  ];
}

/** Confirmation step (§31): nothing is persisted before this explicit press. */
export function alertConfirmKeyboard(): Keyboard {
  return [
    [
      { text: '✅ تأیید', callbackData: callbackDataForAlertConfirm() },
      { text: '❌ لغو', callbackData: callbackDataForAlertCancel() },
    ],
  ];
}

export function alertsListKeyboard(
  alerts: readonly { id: string; label: string; status: AlertStatus }[],
): Keyboard {
  const rows = alerts.map((alert) => [
    {
      text: `${alert.status === 'TRIGGERED' ? '✅' : alert.status === 'DISABLED' ? '🔕' : '🔔'} ${alert.label}`,
      callbackData: callbackDataForAlertView(alert.id),
    },
  ]);

  return [
    [{ text: '➕ ساخت هشدار', callbackData: callbackDataForAlertNew() }],
    ...rows,
    ...screenFooter(),
  ];
}

/** Actions allowed for the current status (§40): a triggered one-shot alert can only be deleted. */
export function alertDetailKeyboard(
  status: AlertStatus,
  alertId: string,
): Keyboard {
  const actions: KeyboardRow[] = [];

  if (status === 'ACTIVE') {
    actions.push([
      {
        text: '🔕 غیرفعال',
        callbackData: callbackDataForAlertStatus('disable', alertId),
      },
      { text: '✏️ ویرایش', callbackData: callbackDataForAlertEdit(alertId) },
    ]);
  } else if (status === 'DISABLED') {
    actions.push([
      {
        text: '🔔 فعال کردن',
        callbackData: callbackDataForAlertStatus('enable', alertId),
      },
      { text: '✏️ ویرایش', callbackData: callbackDataForAlertEdit(alertId) },
    ]);
  }

  actions.push([
    { text: '🗑 حذف', callbackData: callbackDataForAlertDelete(alertId) },
  ]);

  return [
    [{ text: '🔔 هشدارهای من', callbackData: callbackDataForAlertList() }],
    ...actions,
    ...screenFooter(),
  ];
}

export function alertDeleteConfirmKeyboard(alertId: string): Keyboard {
  return [
    [
      {
        text: '🗑 بله، حذف شود',
        callbackData: callbackDataForAlertDeleteConfirm(alertId),
      },
      { text: '↩️ انصراف', callbackData: callbackDataForAlertView(alertId) },
    ],
  ];
}

export function alertCreatedKeyboard(): Keyboard {
  return [
    [
      { text: '🔔 هشدارهای من', callbackData: callbackDataForAlertList() },
      { text: '➕ ساخت هشدار', callbackData: callbackDataForAlertNew() },
    ],
    ...screenFooter(),
  ];
}

export function alertCanceledKeyboard(): Keyboard {
  return [
    [
      { text: '➕ ساخت هشدار', callbackData: callbackDataForAlertNew() },
      { text: '🔔 هشدارهای من', callbackData: callbackDataForAlertList() },
    ],
    ...screenFooter(),
  ];
}
