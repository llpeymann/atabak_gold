import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { buildBrandFooterLines } from '../common/branding';
import { escapeHtml } from '../common/html';
import { PublishableMarketUpdate } from '../market/market.types';
import { formatChangePercent, formatPriceValue } from '../market/price-format';

/**
 * Text poster (short market summary) published three times a day.
 *
 * Phase 1: consumes the same approved `PublishableMarketUpdate` as the channel message, so the
 * poster can never display a price that failed validation.
 */
@Injectable()
export class PosterService {
  private static readonly MAX_ROWS_PER_SECTION = 5;

  constructor(private readonly config: AppConfigService) {}

  generatePricePoster(update: PublishableMarketUpdate): string {
    if (!update.publishable) {
      throw new Error(
        `PosterService received a non-publishable update (${update.blockingReason ?? 'unknown reason'}).`,
      );
    }

    const gold = update.prices.filter(
      (price) => price.section === 'gold' || price.section === 'coins',
    );
    const currency = update.prices.filter(
      (price) => price.section === 'currency',
    );

    const lines: string[] = [
      '💰 <b>گزارش لحظه‌ای بازار</b> 💰',
      `📅 ${escapeHtml(update.dateFa)}`,
    ];

    if (gold.length > 0) {
      lines.push('', '🔸 <b>طلا و سکه</b>');
      for (const price of gold.slice(0, PosterService.MAX_ROWS_PER_SECTION)) {
        lines.push(
          this.renderRow(
            price.label,
            price.price,
            price.unit,
            price.percentageChange,
          ),
        );
      }
    }

    if (currency.length > 0) {
      lines.push('', '🔹 <b>ارز</b>');
      for (const price of currency.slice(
        0,
        PosterService.MAX_ROWS_PER_SECTION,
      )) {
        lines.push(
          this.renderRow(
            price.label,
            price.price,
            price.unit,
            price.percentageChange,
          ),
        );
      }
    }

    lines.push('', ...buildBrandFooterLines());

    return lines.join('\n');
  }

  private renderRow(
    label: string,
    price: number,
    unit: PublishableMarketUpdate['prices'][number]['unit'],
    percentageChange: number | null,
  ): string {
    const percent = formatChangePercent(percentageChange);
    const suffix = percent === null ? '' : ` (${escapeHtml(percent)})`;

    return `▫️ ${escapeHtml(label)}: ${escapeHtml(
      formatPriceValue(price, unit, this.config.displayUnit),
    )}${suffix}`;
  }
}
