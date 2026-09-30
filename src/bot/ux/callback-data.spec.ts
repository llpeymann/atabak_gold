import {
  callbackDataForBack,
  callbackDataForFavorite,
  callbackDataForHome,
  callbackDataForManageFavorites,
  callbackDataForMenu,
  callbackDataForNoop,
  callbackDataForScreen,
  isSafeSymbol,
  parseCallbackData,
  SCREEN_KEYS,
} from './callback-data';

describe('callback data', () => {
  it('round-trips every navigation payload', () => {
    expect(parseCallbackData(callbackDataForMenu())).toEqual({ kind: 'menu' });
    expect(parseCallbackData(callbackDataForHome())).toEqual({ kind: 'home' });
    expect(parseCallbackData(callbackDataForBack())).toEqual({ kind: 'back' });
    expect(parseCallbackData(callbackDataForNoop())).toEqual({ kind: 'noop' });
    expect(parseCallbackData(callbackDataForManageFavorites())).toEqual({
      kind: 'manage-favorites',
    });
  });

  it('round-trips every screen payload', () => {
    for (const screen of SCREEN_KEYS) {
      expect(parseCallbackData(callbackDataForScreen(screen))).toEqual({
        kind: 'screen',
        screen,
      });
    }
  });

  it('round-trips favorite payloads', () => {
    expect(parseCallbackData(callbackDataForFavorite('add', 'USD'))).toEqual({
      kind: 'favorite',
      op: 'add',
      symbol: 'USD',
    });
    expect(
      parseCallbackData(callbackDataForFavorite('remove', 'IR_GOLD_18K')),
    ).toEqual({ kind: 'favorite', op: 'remove', symbol: 'IR_GOLD_18K' });
  });

  it('stays inside the platform payload budget', () => {
    for (const screen of SCREEN_KEYS) {
      expect(callbackDataForScreen(screen).length).toBeLessThanOrEqual(64);
    }
    expect(
      callbackDataForFavorite('remove', 'IR_COIN_QUARTER').length,
    ).toBeLessThanOrEqual(64);
  });

  it('carries no ownership information', () => {
    // A payload never names a user, so a tampered callback cannot address someone else's data.
    expect(callbackDataForFavorite('add', 'USD')).not.toMatch(/user|usr|chat/i);
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['unknown action', 'v1:unknown'],
    ['legacy version', 'v0:screen:prices'],
    ['missing version', 'screen:prices'],
    ['unknown screen', 'v1:screen:secret'],
    ['over-long screen payload', 'v1:screen:prices:extra'],
    ['favorite without symbol', 'v1:fav:add'],
    ['favorite with bad op', 'v1:fav:toggle:USD'],
    ['favorite with lower-case symbol', 'v1:fav:add:usd'],
    ['favorite with injection attempt', 'v1:fav:add:USD;DROP'],
    ['favorite with another user id', 'v1:fav:add:usr_123'],
    ['menu with extra parts', 'v1:menu:extra'],
  ])('rejects %s', (_label, payload) => {
    expect(parseCallbackData(payload as string)).toBeNull();
  });

  it('accepts only registry-shaped symbols', () => {
    expect(isSafeSymbol('IR_GOLD_18K')).toBe(true);
    expect(isSafeSymbol('XAUUSD')).toBe(true);
    expect(isSafeSymbol('ir_gold_18k')).toBe(false);
    expect(isSafeSymbol('GOLD-18')).toBe(false);
    expect(isSafeSymbol('A'.repeat(33))).toBe(false);
  });
});
