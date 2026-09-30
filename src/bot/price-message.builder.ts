import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { buildBrandFooterLines, MESSAGE_DIVIDER } from '../common/branding';
import { escapeHtml } from '../common/html';
import { formatMoney, formatPercentFa } from '../common/money';
import { MarketData, MarketPriceItem } from '../price/price.interface';
import {
  TrendDirection,
  TrendSnapshotEntry,
  TrendTracker,
} from './trend-tracker';

export interface PriceMessageContext {
  /** Tehran calendar day, e.g. `2026-09-30`. */
  dayKey: string;
  /** Persian display date. */
  dateFa: string;
  /** Persian display time. */
  timeFa: string;
}

export interface BuiltPriceMessage {
  text: string;
  /** Prices that become the new comparison baseline once the message is delivered. */
  snapshot: TrendSnapshotEntry[];
}

interface SymbolDefinition {
  symbol: string;
  label: string;
}

const TREND_EMOJI: Record<TrendDirection, string> = {
  unknown: '◽',
  up: '🔺',
  down: '🔻',
  flat: '🔹',
};

const GOLD_SYMBOLS: readonly SymbolDefinition[] = [
  { symbol: 'XAUUSD', label: 'اونس جهانی' },
  { symbol: 'IR_GOLD_18K', label: 'طلای ۱۸ عیار' },
  { symbol: 'IR_GOLD_24K', label: 'طلای ۲۴ عیار' },
  { symbol: 'IR_GOLD_MELTED', label: 'آبشده نقدی' },
];

const COIN_SYMBOLS: readonly SymbolDefinition[] = [
  { symbol: 'IR_COIN_EMAMI', label: 'سکه امامی' },
  { symbol: 'IR_COIN_BAHAR', label: 'سکه تمام بهار' },
  { symbol: 'IR_COIN_HALF', label: 'نیم سکه' },
  { symbol: 'IR_COIN_QUARTER', label: 'ربع سکه' },
  { symbol: 'IR_COIN_1G', label: 'سکه گرمی' },
];

const CURRENCY_SYMBOLS: readonly SymbolDefinition[] = [
  { symbol: 'USDT_IRT', label: 'تتر (فی)' },
  { symbol: 'USD', label: '🇺🇸 دلار آمریکا' },
  { symbol: 'EUR', label: '🇪🇺 یورو' },
  { symbol: 'GBP', label: '🇬🇧 پوند' },
  { symbol: 'TRY', label: '🇹🇷 لیر ترکیه' },
  { symbol: 'AED', label: '🇦🇪 درهم امارات' },
  { symbol: 'CNY', label: '🇨🇳 یوآن چین' },
];

/**
 * Builds the channel price message.
 *
 * Kept as a pure, injectable unit (no delivery, no scheduling) so the Phase 0 behaviour
 * — explicit currency units, trend emojis, consistent footer — is directly testable.
 */
@Injectable()
export class PriceMessageBuilder {
  constructor(
    private readonly config: AppConfigService,
    private readonly trends: TrendTracker,
  ) {}

  build(data: MarketData, context: PriceMessageContext): BuiltPriceMessage {
    const displayUnit = this.config.displayUnit;
    const bySymbol = new Map<string, MarketPriceItem>();

    for (const item of [...data.gold, ...data.currency]) {
      if (!bySymbol.has(item.symbol)) {
        bySymbol.set(item.symbol, item);
      }
    }

    const snapshot: TrendSnapshotEntry[] = [];

    const renderSection = (
      definitions: readonly SymbolDefinition[],
    ): string[] => {
      const lines: string[] = [];

      for (const definition of definitions) {
        const item = bySymbol.get(definition.symbol);
        if (!item) {
          continue;
        }

        const trend = this.trends.trendFor(
          definition.symbol,
          item.priceInRial,
          context.dayKey,
        );
        const percent = formatPercentFa(item.changePercent);
        const percentSuffix = percent ? ` (${percent})` : '';

        lines.push(
          `${escapeHtml(definition.label)}: ` +
            `<b>${escapeHtml(formatMoney(item.priceInRial, displayUnit))}</b> ` +
            `${TREND_EMOJI[trend]}${percentSuffix}`,
        );

        snapshot.push({
          symbol: definition.symbol,
          priceInRial: item.priceInRial,
        });
      }

      return lines;
    };

    const lines: string[] = [
      '📌 <b>گزارش لحظه‌ای بازار</b>',
      `🕒 ${escapeHtml(context.dateFa)} | ${escapeHtml(context.timeFa)}`,
      MESSAGE_DIVIDER,
      '🟨 <b>طلا</b>',
      ...renderSection(GOLD_SYMBOLS),
      '',
      '🪙 <b>سکه</b>',
      ...renderSection(COIN_SYMBOLS),
      '',
      // The unit is attached to every single price below, so the old ambiguous
      // «ارز (تومان)» heading is no longer needed.
      '💰 <b>بازار ارز</b>',
      ...renderSection(CURRENCY_SYMBOLS),
      '',
      ...buildBrandFooterLines(),
    ];

    return { text: lines.join('\n'), snapshot };
  }
}
