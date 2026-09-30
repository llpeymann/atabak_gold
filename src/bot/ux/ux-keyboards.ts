import { Keyboard } from '../../platform/platform.types';
import { FavoritesManageView } from './ux-view.types';
import {
  callbackDataForBack,
  callbackDataForFavorite,
  callbackDataForHome,
  callbackDataForManageFavorites,
  callbackDataForScreen,
  ScreenKey,
} from './callback-data';

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

export function mainMenuKeyboard(): Keyboard {
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

export function menuKeyboard(): Keyboard {
  return [
    ...mainMenuKeyboard(),
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

export function channelKeyboard(url: string): Keyboard {
  return [[{ text: '📢 عضویت در کانال اتابک', url }], ...screenFooter()];
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
