import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { PriceService } from '../price/price.service';
import { BaleService } from '../bale/bale.service';
import { PosterService } from '../poster/poster.service';

@Injectable()
export class BotService {
  private static readonly TIME_ZONE = 'Asia/Tehran';

  private readonly logger = new Logger(BotService.name);
  private readonly lastPrices: Map<string, number> = new Map();
  private readonly CHANNEL_ID: string;

  constructor(
    private readonly priceService: PriceService,
    private readonly baleService: BaleService,
    private readonly configService: ConfigService,
    private readonly posterService: PosterService,
  ) {
    this.CHANNEL_ID =
      this.configService.get<string>('BALE_CHANNEL_ID') || '';

    if (!this.CHANNEL_ID) {
      this.logger.error('BALE_CHANNEL_ID is not configured.');
    }
  }

  /**
   * ارسال پوستر قیمت در ساعت‌های ۱۲، ۱۶ و ۱۹ به وقت ایران
   */
  @Cron('0 0 12,16,19 * * *', {
    timeZone: BotService.TIME_ZONE,
  })
  async sendPricePoster(): Promise<void> {
    if (!this.CHANNEL_ID) {
      this.logger.warn(
        'CHANNEL_ID is not configured, skipping poster cron job.',
      );
      return;
    }

    try {
      this.logger.log('Generating and sending price poster...');

      const data = await this.priceService.getPrices();

      if (!data) {
        throw new Error('API returned no data for poster');
      }

      const imageBuffer =
        await this.posterService.generatePricePoster(data);

      const caption =
        `\n━━━━━━━━━━━━━━━━\n` +
        `📎 خرید و فروش طلا و ارز با نرخ روز\n` +
        `👔 ثبت سفارش: @atabak_admin\n` +
        `📱 شماره تماس: 09123510031\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🆔 @tala_atabak`;

      await this.baleService.sendPhotoBuffer(
        this.CHANNEL_ID,
        imageBuffer,
        caption,
        'HTML',
      );

      this.logger.log('Price poster sent successfully.');
    } catch (error: any) {
      this.logger.error(
        `Failed to send price poster: ${error?.message}`,
        error?.stack,
      );
    }
  }

  /**
   * ارسال پیام قیمت از ساعت ۰۸:۰۰ تا ۲۱:۳۰،
   * هر نیم ساعت به وقت ایران
   */
  @Cron('0 0,30 8-21 * * *', {
    timeZone: BotService.TIME_ZONE,
  })

  /**
   * آخرین پیام روز در ساعت ۲۲:۰۰ به وقت ایران
   */
  @Cron('0 0 22 * * *', {
    timeZone: BotService.TIME_ZONE,
  })
  async handleCron(): Promise<void> {
    if (!this.CHANNEL_ID) {
      this.logger.warn(
        'CHANNEL_ID is not configured, skipping price cron job.',
      );
      return;
    }

    try {
      this.logger.log('⏳ Starting price update process...');

      const data = await this.priceService.getPrices();

      if (!data) {
        throw new Error('API returned no data');
      }

      const now = new Date();

      const currentTimeFa = now.toLocaleTimeString('fa-IR', {
        timeZone: BotService.TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

      const currentDateFa = now.toLocaleDateString('fa-IR', {
        timeZone: BotService.TIME_ZONE,
      });

      const message = this.formatMessage(
        data,
        currentDateFa,
        currentTimeFa,
      );

      this.logger.log(
        `📩 Sending price message to Bale channel at ${currentTimeFa}...`,
      );

      await this.baleService.sendMessage(
        this.CHANNEL_ID,
        message,
        'HTML',
      );

      this.logger.log('✅ Market update sent successfully.');
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to send market update: ${error?.message}`,
        error?.stack,
      );
    }
  }

  private escapeHtml(value: any): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private formatMessage(
    data: any,
    currentDate: string,
    currentTime: string,
  ): string {
    const gold = data?.gold || [];
    const currency = data?.currency || [];

    const formatPrice = (value: any): string => {
      const number = Number(value);

      return Number.isNaN(number)
        ? '---'
        : number.toLocaleString('fa-IR');
    };

    const getTrendEmoji = (
      symbol: string,
      currentPrice: number,
    ): string => {
      const lastPrice = this.lastPrices.get(symbol);

      this.lastPrices.set(symbol, currentPrice);

      if (lastPrice === undefined) {
        return '◽';
      }

      if (currentPrice > lastPrice) {
        return '🔺';
      }

      if (currentPrice < lastPrice) {
        return '🔻';
      }

      return '🔹';
    };

    const formatLine = (
      item: any,
      label?: string,
    ): string | null => {
      if (!item || item.price === undefined || item.price === null) {
        return null;
      }

      const currentPrice = Number(item.price);

      const trendEmoji = getTrendEmoji(
        item.symbol,
        currentPrice,
      );

      const name = this.escapeHtml(
        label || item.name || item.symbol,
      );

      const price = this.escapeHtml(
        formatPrice(item.price),
      );

      const unit = this.escapeHtml(item.unit || '');

      const changePercent =
        item.change_percent !== undefined &&
        item.change_percent !== null
          ? ` (${this.escapeHtml(item.change_percent)}%)`
          : '';

      return (
        `${name}: <b>${price}</b> ${unit} ` +
        `${trendEmoji}${changePercent}`
      );
    };

    const lines: string[] = [
      '📌 <b>گزارش لحظه‌ای بازار</b>',
      `🕒 ${this.escapeHtml(currentDate)} | ${this.escapeHtml(currentTime)}`,
      '━━━━━━━━━━━━━━━━',
      '🟨 <b>طلا</b>',
    ];

    const goldItems = [
      {
        symbol: 'XAUUSD',
        label: 'اونس جهانی',
      },
      {
        symbol: 'IR_GOLD_18K',
        label: 'طلای ۱۸ عیار',
      },
      {
        symbol: 'IR_GOLD_24K',
        label: 'طلای ۲۴ عیار',
      },
      {
        symbol: 'IR_GOLD_MELTED',
        label: 'آبشده نقدی',
      },
    ];

    goldItems.forEach((goldItem) => {
      const item = gold.find(
        (goldData: any) =>
          goldData.symbol === goldItem.symbol,
      );

      const line = formatLine(
        item,
        goldItem.label,
      );

      if (line) {
        lines.push(line);
      }
    });

    lines.push('', '🪙 <b>سکه</b>');

    const coinItems = [
      {
        symbol: 'IR_COIN_EMAMI',
        label: 'سکه امامی',
      },
      {
        symbol: 'IR_COIN_BAHAR',
        label: 'سکه تمام بهار',
      },
      {
        symbol: 'IR_COIN_HALF',
        label: 'نیم سکه',
      },
      {
        symbol: 'IR_COIN_QUARTER',
        label: 'ربع سکه',
      },
      {
        symbol: 'IR_COIN_1G',
        label: 'سکه گرمی',
      },
    ];

    coinItems.forEach((coinItem) => {
      const item = gold.find(
        (goldData: any) =>
          goldData.symbol === coinItem.symbol,
      );

      const line = formatLine(
        item,
        coinItem.label,
      );

      if (line) {
        lines.push(line);
      }
    });

    lines.push('', '💰 <b>ارز (تومان)</b>');

    const currencyItems = [
      {
        symbol: 'USDT_IRT',
        label: 'تتر (فی)',
      },
      {
        symbol: 'USD',
        label: '🇱🇷 دلار آمریکا',
      },
      {
        symbol: 'EUR',
        label: '🇪🇺 یورو',
      },
      {
        symbol: 'GBP',
        label: '🇬🇧 پوند',
      },
      {
        symbol: 'TRY',
        label: '🇹🇷 لیر ترکیه',
      },
      {
        symbol: 'AED',
        label: '🇦🇪 درهم امارات',
      },
      {
        symbol: 'CNY',
        label: '🇨🇳 یوآن چین',
      },
    ];

    currencyItems.forEach((currencyItem) => {
      const item = currency.find(
        (currencyData: any) =>
          currencyData.symbol === currencyItem.symbol,
      );

      const line = formatLine(
        item,
        currencyItem.label,
      );

      if (line) {
        lines.push(line);
      }
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
