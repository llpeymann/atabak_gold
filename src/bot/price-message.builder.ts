import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { buildBrandFooterLines, MESSAGE_DIVIDER } from '../common/branding';
import { escapeHtml } from '../common/html';
import {
  MarketSection,
  PublishableMarketUpdate,
  PublishablePrice,
} from '../market/market.types';
import {
  directionEmoji,
  formatChangePercent,
  formatPriceValue,
} from '../market/price-format';
import { SECTION_TITLES } from '../market/symbols';

/**
 * Channel message builder.
 *
 * Phase 1: the builder only accepts a `PublishableMarketUpdate` — an object produced by the market
 * reliability pipeline that contains nothing but *approved* prices. It has no access to raw API
 * data, which makes it structurally impossible to publish an unvalidated or rejected price.
 */
@Injectable()
export class PriceMessageBuilder {
  constructor(private readonly config: AppConfigService) {}

  build(update: PublishableMarketUpdate): string {
    if (!update.publishable) {
      throw new Error(
        `PriceMessageBuilder received a non-publishable update (${update.blockingReason ?? 'unknown reason'}).`,
      );
    }

    const lines: string[] = [
      '📌 <b>گزارش لحظه‌ای بازار</b>',
      `🕒 ${escapeHtml(update.dateFa)} | ${escapeHtml(update.timeFa)}`,
      MESSAGE_DIVIDER,
    ];

    let firstSection = true;

    for (const section of ['gold', 'coins', 'currency'] as MarketSection[]) {
      const prices = update.prices.filter((price) => price.section === section);

      if (prices.length === 0) {
        continue;
      }

      if (!firstSection) {
        lines.push('');
      }
      firstSection = false;

      lines.push(SECTION_TITLES[section]);

      for (const price of prices) {
        lines.push(this.renderPrice(price));
      }
    }

    lines.push('', ...buildBrandFooterLines());

    return lines.join('\n');
  }

  private renderPrice(price: PublishablePrice): string {
    const percent = formatChangePercent(price.percentageChange);
    const percentSuffix = percent === null ? '' : ` (${escapeHtml(percent)})`;

    return (
      `${escapeHtml(price.label)}: ` +
      `<b>${escapeHtml(formatPriceValue(price.price, price.unit, this.config.displayUnit))}</b> ` +
      `${directionEmoji(price.direction)}${percentSuffix}`
    );
  }
}
