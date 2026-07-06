import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PriceService } from '../price/price.service';
import { BaleService } from '../bale/bale.service';
import { ConfigService } from '@nestjs/config';
import { PriceStorageService } from '../price-storage/price-storage.service';
import { PosterService } from '../poster/poster.service';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

interface Candle {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

@Injectable()
export class BotService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotService.name);
  private lastPrices: Map<string, number> = new Map();
  private readonly CHANNEL_ID: string;

  constructor(
    private readonly priceService: PriceService,
    private readonly baleService: BaleService,
    private readonly configService: ConfigService,
    private readonly storageService: PriceStorageService,
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

      await this.baleService.sendPhotoBuffer(this.CHANNEL_ID, imageBuffer, caption);
      this.logger.log('Price poster sent successfully.');
    } catch (error: any) {
      this.logger.error(`Failed to send price poster: ${error.message}`);
      throw error;
    }
  }

  // ارسال از ۱۰:۰۰ تا ۱۹:۳۰، هر نیم ساعت
  @Cron('0 0,30 10-19 * * *')
  // ارسال نهایی ساعت ۲۰:۰۰
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

      const gold = data?.gold || [];
      const gold18k = gold.find((item: any) => item.symbol === 'IR_GOLD_18K');

      const now = new Date();
      const currentTimeFa = now.toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const currentDateFa = now.toLocaleDateString('fa-IR');
      const currentTimeEn = now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

      if (gold18k) {
        await this.storageService.savePrice('IR_GOLD_18K', Number(gold18k.price), currentTimeEn);
      }

      const message = this.formatMessage(data, currentDateFa, currentTimeFa);

      this.logger.log('📩 Sending message to Bale channel...');
      await this.baleService.sendMessage(this.CHANNEL_ID, message, 'HTML');

      this.logger.log('✅ Market update sent successfully.');
    } catch (error: any) {
      this.logger.error(`❌ Failed to send market update: ${error?.message}`);
    }
  }

  @Cron('0 1 21 * * *')
  async sendDailyChart() {
    try {
      this.logger.log('Generating final daily candlestick chart for 9:01 PM report...');

      const allData = await this.storageService.getAllData();
      const goldData = allData['IR_GOLD_18K'] || [];

      if (goldData.length < 2) {
        this.logger.warn('Insufficient data for generating daily chart.');
        return;
      }

      const pythonData = this.generateHourlyCandles(goldData);
      const tempDir = path.join(process.cwd(), 'temp');
      await fs.promises.mkdir(tempDir, { recursive: true });

      const inputPath = path.join(tempDir, 'chart_data.json');
      const outputPath = path.join(tempDir, 'daily_chart.png');

      await fs.promises.writeFile(inputPath, JSON.stringify(pythonData), 'utf-8');

      const pythonScriptPath = path.join(process.cwd(), 'scripts', 'generate_chart.py');
      const { stderr } = await execAsync(`python "${pythonScriptPath}" "${inputPath}" "${outputPath}"`);

      if (stderr && !stderr.includes('UserWarning')) {
        this.logger.error(`Python script error: ${stderr}`);
      }

      const imageBuffer = await fs.promises.readFile(outputPath);
      const todayFa = new Date().toLocaleDateString('fa-IR', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      const caption =
        `📊 <b>گزارش تحلیلی تغییرات طلای ۱۸ عیار</b>\n\n` +
        `📅 <b>تاریخ:</b> ${this.escapeHtml(todayFa)}\n` +
        `📈 این نمودار نمایش‌دهنده نوسانات قیمتی بازار از شروع معاملات امروز تا لحظه بسته‌شدن است.\n\n` +
        `✨ <b>تحلیل هوشمند بازار طلا - طلای اتابک</b>`;

      await this.baleService.sendPhotoBuffer(this.CHANNEL_ID, imageBuffer, caption, 'HTML');

      if (fs.existsSync(inputPath)) await fs.promises.unlink(inputPath);
      if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath);

      await this.storageService.clearDailyData();

      this.logger.log('Daily chart sent successfully. Cleaned up temp files.');
    } catch (error: any) {
      this.logger.error(`Failed to send daily chart: ${error.message}`);
    }
  }

  private generateHourlyCandles(data: any[]): Candle[] {
    const groups: { [key: string]: number[] } = {};

    data.forEach((d) => {
      const hour = d.time.split(':')[0];
      if (!groups[hour]) groups[hour] = [];
      groups[hour].push(Number(d.price));
    });

    return Object.keys(groups)
      .sort()
      .map((hour) => {
        const prices = groups[hour];

        return {
          t: `${hour}:00`,
          o: prices[0],
          h: Math.max(...prices),
          l: Math.min(...prices),
          c: prices[prices.length - 1],
        };
      });
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
