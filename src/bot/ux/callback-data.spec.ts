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
  isAlertAction,
  isSafeAlertId,
} from './callback-data';
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

describe('alert callback grammar', () => {
  it('round-trips every alert payload', () => {
    const payloads = [
      callbackDataForAlertNew(),
      callbackDataForAlertList(),
      callbackDataForAlertSymbol('IR_GOLD_18K'),
      callbackDataForAlertType('above'),
      callbackDataForAlertType('below'),
      callbackDataForAlertType('up'),
      callbackDataForAlertType('down'),
      callbackDataForAlertConfirm(),
      callbackDataForAlertCancel(),
      callbackDataForAlertView('alr_ab12_x9'),
      callbackDataForAlertStatus('enable', 'alr_ab12_x9'),
      callbackDataForAlertStatus('disable', 'alr_ab12_x9'),
      callbackDataForAlertEdit('alr_ab12_x9'),
      callbackDataForAlertDelete('alr_ab12_x9'),
      callbackDataForAlertDeleteConfirm('alr_ab12_x9'),
    ];

    for (const payload of payloads) {
      const parsed = parseCallbackData(payload);
      expect(parsed).not.toBeNull();
      expect(isAlertAction(parsed as never)).toBe(true);
    }
  });

  it('reports the alert action details', () => {
    expect(parseCallbackData(callbackDataForAlertSymbol('USD'))).toEqual({
      kind: 'alert-symbol',
      symbol: 'USD',
    });
    expect(parseCallbackData(callbackDataForAlertType('down'))).toEqual({
      kind: 'alert-type',
      type: 'down',
    });
    expect(
      parseCallbackData(callbackDataForAlertStatus('disable', 'alr_x1')),
    ).toEqual({ kind: 'alert-disable', alertId: 'alr_x1' });
    expect(
      parseCallbackData(callbackDataForAlertStatus('enable', 'alr_x1')),
    ).toEqual({
      kind: 'alert-enable',
      alertId: 'alr_x1',
    });
  });

  it('accepts only well-formed alert ids', () => {
    for (const id of ['alr_x1', 'alr_ab12_x9', 'alr_1']) {
      expect(isSafeAlertId(id)).toBe(true);
      expect(parseCallbackData(callbackDataForAlertView(id))).not.toBeNull();
    }

    for (const id of [
      '',
      'x1',
      'alr_',
      'ALR_X1',
      'alr_' + 'a'.repeat(41),
      'alr_x1;drop',
      'alr_x1/../etc',
    ]) {
      expect(isSafeAlertId(id)).toBe(false);
    }
  });

  it('rejects malformed alert payloads instead of guessing', () => {
    for (const payload of [
      'v1:alert:',
      'v1:alert:unknown',
      'v1:alert:sym:',
      'v1:alert:sym:not-a-symbol',
      'v1:alert:type:sideways',
      'v1:alert:view:not-an-id',
      'v1:alert:st:enable:not-an-id',
      'v1:alert:del:not-an-id',
      'v1:alert:confirm:x',
    ]) {
      expect(parseCallbackData(payload)).toBeNull();
    }
  });

  it('checks the *shape* only: the registry decides whether a symbol is supported', () => {
    // A syntactically valid but unknown symbol reaches the router, which refuses it against the
    // canonical Phase 1 registry (never against a local list).
    const parsed = parseCallbackData(
      callbackDataForAlertSymbol('NOT_A_SYMBOL'),
    );

    expect(parsed).toEqual({ kind: 'alert-symbol', symbol: 'NOT_A_SYMBOL' });
  });

  it('carries no ownership information in alert buttons', () => {
    const payload = callbackDataForAlertView('alr_abc_1');

    expect(payload).not.toContain('usr');
    expect(payload.split(':')).toHaveLength(4);
  });

  it('stays inside the platform payload budget', () => {
    const longest = callbackDataForAlertDeleteConfirm('alr_' + 'a'.repeat(40));

    expect(longest.length).toBeLessThanOrEqual(64);
  });
});

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
