import { escapeHtml, normalizeHtmlForDelivery } from './html';

describe('html helpers', () => {
  it('escapes values that are inserted into a parsed message', () => {
    expect(escapeHtml('<script>&')).toBe('&lt;script&gt;&amp;');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('normalizes <b> markup for delivery (Bale compatibility)', () => {
    expect(normalizeHtmlForDelivery('<b>price</b>')).toBe(
      '<strong>price</strong>',
    );
    expect(normalizeHtmlForDelivery('')).toBe('');
  });
});
