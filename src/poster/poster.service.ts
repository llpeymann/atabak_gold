import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { buildBrandFooterLines } from '../common/branding';
import { escapeHtml } from '../common/html';
import { formatMoney } from '../common/money';
import { tehranDateFa } from '../common/tehran-time';
import { MarketData } from '../price/price.interface';

/**
 * Text poster (short market summary) published three times a day.
 *
 * Phase 0 changes: synchronous (it never awaited anything), prices go through the shared
 * money formatter (explicit unit instead of a hard-coded «ریال»), and the footer is the
 * shared brand footer instead of a second, divergent branding string.
 */
@Injectable()
export class PosterService {
  constructor(private readonly config: AppConfigService) {}

  generatePricePoster(data: MarketData): string {
    const displayUnit = this.config.displayUnit;
    const lines: string[] = [
      '💰 <b>گزارش لحظه‌ای بازار</b> 💰',
      `📅 ${escapeHtml(tehranDateFa(new Date()))}`,
    ];

    if (data.gold.length > 0) {
      lines.push('', '🔸 <b>طلا و سکه</b>');
      for (const item of data.gold.slice(0, 5)) {
        lines.push(
          `▫️ ${escapeHtml(item.symbol)}: ${escapeHtml(formatMoney(item.priceInRial, displayUnit))}`,
        );
      }
    }

    if (data.currency.length > 0) {
      lines.push('', '🔹 <b>ارز</b>');
      for (const item of data.currency.slice(0, 5)) {
        lines.push(
          `▫️ ${escapeHtml(item.symbol)}: ${escapeHtml(formatMoney(item.priceInRial, displayUnit))}`,
        );
      }
    }

    lines.push('', ...buildBrandFooterLines());

    return lines.join('\n');
  }
}
