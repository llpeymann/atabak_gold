import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PriceService } from '../price/price.service';
import { BaleService } from '../bale/bale.service';
import { ConfigService } from '@nestjs/config';
import { PosterService } from '../poster/poster.service';

@Injectable()
export class BotService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotService.name);
  private lastPrices: Map<string, number> = new Map();
  private readonly CHANNEL_ID: string;

  constructor(
    private readonly priceService: PriceService,
    private readonly baleService: BaleService,
    private readonly configService: ConfigService,
    private readonly posterService: PosterService,
  ) {
    this.CHANNEL_ID = this.configService.get<string>('BALE_CHANNEL_ID') || '';
    if (!this.CHANNEL_ID) {
      this.logger.error('BALE_CHANNEL_ID is not configured.');
    }
  }

  async onApplicationBootstrap() {
    this.logger.log('🚀 Bot Service initialized. Running startup test...');
    try {
      await this.handleCron();
    } catch (error: any) {
      this.logger.error(`❌ Startup Test failed: ${error.message}`);
    }
  }

  @Cron('0 0 12,16,19 * * *')
  async sendPricePoster() {
    if (!this.CHANNEL_ID) return;

    try {
      this.logger.log('Generating and sending price poster...');

      const data = await this.priceService.getPrices();
      if (!data) throw new Error('API returned no data for poster');

      const imageBuffer = await this.posterService.generatePricePoster(data);

      const caption =
        `\n━━━━━━━━━━━━━━━━\n` +
        `📎 خرید و فروش طلا و ارز با نرخ روز\n` +
        `👔 ثبت سفارش: @atabak_gold_admin\n` +
        `📱 شماره تماس: 09123510031\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🆔 @atabak_gold`;

      await this.baleService.sendPhotoBuffer(this.CHANNEL_ID, imageBuffer, caption, 'HTML');
      this.logger.log('Price poster sent successfully.');
    } catch (error: any) {
      this.logger.error(`Failed to send price poster: ${error.message}`);
      throw error;
    }
  }

  // ۱. ارسال از ۱۰:۰۰ صبح تا ۱۹:۳۰ عصر، دقیقاً هر نیم ساعت
  @Cron('0 0,30 10-19 * * *')
  // ۲. ارسال نهایی در ساعت ۲۰:۰۰ شب
  @Cron('0 0 20 * * *')
  async handleCron() {
    if (!this.CHANNEL_ID) {
      this.logger.warn('CHANNEL_ID is not configured, skipping cron job.');
      return;
    }

    try {
      this.logger.log('⏳ Starting price update process...');

      const data = await this.priceService.getPrices();
      if (!data) throw new Error('API returned no data');

      const now = new Date();
      const currentTimeFa = now.toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const currentDateFa = now.toLocaleDateString('fa-IR');

      const message = this.formatMessage(data, currentDateFa, currentTimeFa);

      this.logger.log('📩 Sending message to Bale channel...');
      await this.baleService.sendMessage(this.CHANNEL_ID, message, 'HTML');

      this.logger.log('✅ Market update sent successfully.');
    } catch (error: any) {
      this.logger.error(`❌ Failed to send market update: ${error?.message}`);
    }
  }

  private escapeHtml(value: any): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private formatMessage(data: any, currentDate: string, currentTime: string): string {
    const gold = data?.gold || [];
    const currency = data?.currency || [];

    const formatPrice = (n: any): string => {
      const num = Number(n);
      return isNaN(num) ? '---' : num.toLocaleString('fa-IR');
    };

    const getTrendEmoji = (symbol: string, currentPrice: number): string => {
      const lastPrice = this.lastPrices.get(symbol);
      this.lastPrices.set(symbol, currentPrice);

      if (lastPrice === undefined) return '◽';
      return currentPrice > lastPrice ? '🔺' : currentPrice < lastPrice ? '🔻' : '🔹';
    };

    const formatLine = (item: any, label?: string): string | null => {
      if (!item || !item.price) return null;

      const trendEmoji = getTrendEmoji(item.symbol, Number(item.price));
      const name = this.escapeHtml(label || item.name || item.symbol);
      const price = this.escapeHtml(formatPrice(item.price));
      const unit = this.escapeHtml(item.unit || '');
      const changePercent = item.change_percent
        ? ` (${this.escapeHtml(item.change_percent)}%)`
        : '';

      return `${name}: <b>${price}</b> ${unit} ${trendEmoji}${changePercent}`;
    };

    const lines: string[] = [
      `📌 <b>گزارش لحظه‌ای بازار</b>`,
      `🕒 ${this.escapeHtml(currentDate)} | ${this.escapeHtml(currentTime)}`,
      `━━━━━━━━━━━━━━━━`,
      `🟨 <b>طلا</b>`,
    ];

    const goldItems = [
      { symbol: 'XAUUSD', label: 'اونس جهانی' },
      { symbol: 'IR_GOLD_18K', label: 'طلای ۱۸ عیار' },
      { symbol: 'IR_GOLD_24K', label: 'طلای ۲۴ عیار' },
      { symbol: 'IR_GOLD_MELTED', label: 'آبشده نقدی' },
    ];

    goldItems.forEach((s) => {
      const item = gold.find((g: any) => g.symbol === s.symbol);
      const line = formatLine(item, s.label);
      if (line) lines.push(line);
    });

    lines.push('', '🪙 <b>سکه</b>');

    const coinItems = [
      { symbol: 'IR_COIN_EMAMI', label: 'سکه امامی' },
      { symbol: 'IR_COIN_BAHAR', label: 'سکه تمام بهار' },
      { symbol: 'IR_COIN_HALF', label: 'نیم سکه' },
      { symbol: 'IR_COIN_QUARTER', label: 'ربع سکه' },
      { symbol: 'IR_COIN_1G', label: 'سکه گرمی' },
    ];

    coinItems.forEach((s) => {
      const item = gold.find((g: any) => g.symbol === s.symbol);
      const line = formatLine(item, s.label);
      if (line) lines.push(line);
    });

    lines.push('', '💰 <b>ارز (تومان)</b>');

    const currencyItems = [
      { symbol: 'USDT_IRT', label: 'تتر (فی)' },
      { symbol: 'USD', label: '🇱🇷 دلار آمریکا' },
      { symbol: 'EUR', label: '🇪🇺 یورو' },
      { symbol: 'GBP', label: '🇬🇧 پوند' },
      { symbol: 'TRY', label: '🇹🇷 لیر ترکیه' },
      { symbol: 'AED', label: '🇦🇪 درهم امارات' },
      { symbol: 'CNY', label: '🇨🇳 یوآن چین' },
    ];

    currencyItems.forEach((s) => {
      const item = currency.find((c: any) => c.symbol === s.symbol);
      const line = formatLine(item, s.label);
      if (line) lines.push(line);
    });

    lines.push(
      '',
      '━━━━━━━━━━━━━━━━',
      '📎 خرید و فروش طلا و ارز با نرخ روز',
      '👔 ثبت سفارش: @atabak_admin',
      '📱 شماره تماس: 09123510031',
      '━━━━━━━━━━━━━━━━',
      '🆔 @tala_atabak',
    );

    return lines.join('\n');
  }
}
