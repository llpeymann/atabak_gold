import { formatMoney, formatPercentFa, MoneyUnit } from '../common/money';
import { PriceDirection, PriceUnit } from './market.types';

/**
 * Presentation boundary for market values.
 *
 * Internal values are never rounded or converted outside this module: the canonical unit of a
 * symbol decides how its number is rendered, and the Rial/Toman choice only applies to
 * Rial-denominated instruments (XAUUSD keeps its USD unit).
 */

export const USD_UNIT_LABEL = 'دلار';

const usdFormatter = new Intl.NumberFormat('fa-IR', {
  maximumFractionDigits: 2,
});

/** Render a canonical market value with an explicit unit. */
export function formatPriceValue(
  amount: number,
  unit: PriceUnit,
  displayUnit: MoneyUnit,
): string {
  if (unit === 'USD') {
    return `${usdFormatter.format(amount)} ${USD_UNIT_LABEL}`;
  }

  return formatMoney(amount, displayUnit);
}

/** Render a full-precision percentage change (rounding happens here, and only here). */
export function formatChangePercent(
  percentageChange: number | null,
): string | null {
  return percentageChange === null ? null : formatPercentFa(percentageChange);
}

const DIRECTION_EMOJI: Record<PriceDirection, string> = {
  UP: '🔺',
  DOWN: '🔻',
  UNCHANGED: '🔹',
  UNKNOWN: '◽',
};

export function directionEmoji(direction: PriceDirection): string {
  return DIRECTION_EMOJI[direction];
}
