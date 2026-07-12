import { Injectable, Logger } from '@nestjs/common';
import {
  CanvasGradient,
  CanvasRenderingContext2D,
  createCanvas,
  registerFont,
} from 'canvas';
import * as path from 'path';

interface MarketPriceItem {
  symbol: string;
  price: number | string;
  change?: number | string;
  percent?: number | string;
}

interface PricePosterData {
  gold?: MarketPriceItem[];
  currency?: MarketPriceItem[];
}

interface PriceRow {
  label: string;
  value: string;
  change?: number;
  percent?: string;
}

@Injectable()
export class PosterService {
  private static readonly TIME_ZONE = 'Asia/Tehran';
  private static readonly FONT_FAMILY = 'Vazir';

  private readonly logger = new Logger(PosterService.name);
  private fontRegistered = false;
  private fontRegistrationAttempted = false;

  /**
   * ثبت فونت فقط یک بار در طول اجرای برنامه
   */
  private registerFontOnce(): void {
    if (this.fontRegistered || this.fontRegistrationAttempted) {
      return;
    }

    this.fontRegistrationAttempted = true;

    try {
      const fontPath = path.resolve(
        process.cwd(),
        'assets',
        'Vazir.ttf',
      );

      registerFont(fontPath, {
        family: PosterService.FONT_FAMILY,
      });

      this.fontRegistered = true;
      this.logger.log(`Font registered successfully: ${fontPath}`);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);

      this.logger.error(`Could not register font: ${message}`);
    }
  }

  /**
   * تولید پوستر از قیمت‌های لحظه‌ای
   *
   * این متد هیچ قیمتی را ذخیره نمی‌کند و به تاریخچه قیمت‌ها
   * یا PriceStorageService وابسته نیست.
   */
  async generatePricePoster(
    data: PricePosterData,
  ): Promise<Buffer> {
    this.registerFontOnce();

    const WIDTH = 600;
    const MARGIN = 28;
    const INNER_WIDTH = WIDTH - MARGIN * 2;

    const HEADER_HEIGHT = 180;
    const FOOTER_HEIGHT = 110;
    const SECTION_GAP = 18;

    const gold = Array.isArray(data?.gold) ? data.gold : [];
    const currency = Array.isArray(data?.currency)
      ? data.currency
      : [];

    /**
     * دریافت یک قیمت از اطلاعات لحظه‌ای API
     */
    const getPriceData = (
      symbol: string,
      list: MarketPriceItem[],
    ): PriceRow => {
      const item = list.find(
        (priceItem) => priceItem.symbol === symbol,
      );

      if (!item) {
        this.logger.warn(
          `Price item not found for symbol: ${symbol}`,
        );

        return {
          label: '',
          value: '---',
        };
      }

      const numericPrice = this.toFiniteNumber(item.price);

      const formattedPrice =
        numericPrice !== undefined
          ? numericPrice.toLocaleString('fa-IR')
          : '---';

      const numericChange = this.toFiniteNumber(item.change);
      const numericPercent = this.toFiniteNumber(item.percent);

      let formattedPercent: string | undefined;

      if (numericPercent !== undefined) {
        const absolutePercent = Math.abs(numericPercent).toLocaleString(
          'fa-IR',
          {
            maximumFractionDigits: 2,
          },
        );

        if (numericPercent > 0) {
          formattedPercent = `+${absolutePercent}٪`;
        } else if (numericPercent < 0) {
          formattedPercent = `-${absolutePercent}٪`;
        } else {
          formattedPercent = `${absolutePercent}٪`;
        }
      }

      return {
        label: '',
        value: formattedPrice,
        change: numericChange,
        percent: formattedPercent,
      };
    };

    /*
     * یک Date مشترک استفاده می‌شود تا تاریخ و ساعت دقیقاً مربوط
     * به یک لحظه باشند.
     */
    const now = new Date();

    const dateFa = now.toLocaleDateString('fa-IR', {
      timeZone: PosterService.TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const timeFa = now.toLocaleTimeString('fa-IR', {
      timeZone: PosterService.TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    /*
     * این مقادیر باید با drawSection هماهنگ باشند.
     */
    const ROW_HEIGHT = 44;
    const TITLE_HEIGHT = 50;
    const SECTION_PADDING = 12;

    const calculateSectionHeight = (
      rowCount: number,
    ): number => {
      return (
        TITLE_HEIGHT +
        rowCount * ROW_HEIGHT +
        SECTION_PADDING
      );
    };

    const goldHeight = calculateSectionHeight(3);
    const coinHeight = calculateSectionHeight(5);
    const currencyHeight = calculateSectionHeight(7);

    const HEIGHT =
      MARGIN +
      HEADER_HEIGHT +
      goldHeight +
      SECTION_GAP +
      coinHeight +
      SECTION_GAP +
      currencyHeight +
      SECTION_GAP +
      FOOTER_HEIGHT +
      MARGIN;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    const fontFamily = this.fontRegistered
      ? PosterService.FONT_FAMILY
      : 'sans-serif';

    // --------------------------------------------------
    // پس‌زمینه
    // --------------------------------------------------

    const backgroundGradient = ctx.createLinearGradient(
      0,
      0,
      0,
      HEIGHT,
    );

    backgroundGradient.addColorStop(0, '#0F0F12');
    backgroundGradient.addColorStop(0.5, '#15161E');
    backgroundGradient.addColorStop(1, '#08080A');

    this.roundRect(
      ctx,
      0,
      0,
      WIDTH,
      HEIGHT,
      28,
      backgroundGradient,
      '#D4AF37',
      2,
    );

    // هاله طلایی پس‌زمینه
    ctx.save();
    ctx.globalAlpha = 0.03;
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth = 120;
    ctx.beginPath();
    ctx.arc(WIDTH / 2, 0, 180, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // --------------------------------------------------
    // هدر پوستر
    // --------------------------------------------------

    ctx.save();
    ctx.shadowColor = 'rgba(212, 175, 55, 0.4)';
    ctx.shadowBlur = 15;
    ctx.fillStyle = '#D4AF37';
    ctx.font = `bold 36px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.direction = 'rtl';
    ctx.fillText(
      'طلای اتابک',
      WIDTH / 2,
      MARGIN + 52,
    );
    ctx.restore();

    ctx.fillStyle = '#A0AEC0';
    ctx.font = `14px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.direction = 'rtl';
    ctx.fillText(
      'مرجع قیمت لحظه‌ای بازار طلا، سکه و ارز',
      WIDTH / 2,
      MARGIN + 80,
    );

    // کادر تاریخ و ساعت
    this.roundRect(
      ctx,
      WIDTH / 2 - 140,
      MARGIN + 94,
      280,
      38,
      12,
      'rgba(212, 175, 55, 0.06)',
      'rgba(212, 175, 55, 0.25)',
      1,
    );

    ctx.fillStyle = '#E2E8F0';
    ctx.font = `bold 13px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.direction = 'rtl';
    ctx.fillText(
      `${dateFa}   |   ساعت ${timeFa}`,
      WIDTH / 2,
      MARGIN + 118,
    );

    // خط جداکننده هدر
    const dividerGradient = ctx.createLinearGradient(
      MARGIN,
      0,
      WIDTH - MARGIN,
      0,
    );

    dividerGradient.addColorStop(0, 'rgba(212, 175, 55, 0)');
    dividerGradient.addColorStop(
      0.3,
      'rgba(212, 175, 55, 0.4)',
    );
    dividerGradient.addColorStop(
      0.7,
      'rgba(212, 175, 55, 0.4)',
    );
    dividerGradient.addColorStop(1, 'rgba(212, 175, 55, 0)');

    ctx.strokeStyle = dividerGradient;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN + 20, MARGIN + 152);
    ctx.lineTo(WIDTH - MARGIN - 20, MARGIN + 152);
    ctx.stroke();

    // --------------------------------------------------
    // ردیف‌های طلا
    // --------------------------------------------------

    const goldRows: PriceRow[] = [
      {
        ...getPriceData('IR_GOLD_18K', gold),
        label: 'طلای ۱۸ عیار (گرم)',
      },
      {
        ...getPriceData('IR_GOLD_24K', gold),
        label: 'طلای ۲۴ عیار (گرم)',
      },
      {
        ...getPriceData('IR_GOLD_MELTED', gold),
        label: 'مظنه آبشده نقدی',
      },
    ];

    // --------------------------------------------------
    // ردیف‌های سکه
    // --------------------------------------------------

    const coinRows: PriceRow[] = [
      {
        ...getPriceData('IR_COIN_EMAMI', gold),
        label: 'سکه امامی (طرح جدید)',
      },
      {
        ...getPriceData('IR_COIN_BAHAR', gold),
        label: 'سکه بهار آزادی (طرح قدیم)',
      },
      {
        ...getPriceData('IR_COIN_HALF', gold),
        label: 'نیم سکه بهار آزادی',
      },
      {
        ...getPriceData('IR_COIN_QUARTER', gold),
        label: 'ربع سکه بهار آزادی',
      },
      {
        ...getPriceData('IR_COIN_1G', gold),
        label: 'سکه گرمی بانک مرکزی',
      },
    ];

    // --------------------------------------------------
    // ردیف‌های ارز
    // --------------------------------------------------

    const currencyRows: PriceRow[] = [
      {
        ...getPriceData('USDT_IRT', currency),
        label: 'تتر (دلار دیجیتال)',
      },
      {
        ...getPriceData('USD', currency),
        label: 'دلار آمریکا (تهران)',
      },
      {
        ...getPriceData('EUR', currency),
        label: 'یورو',
      },
      {
        ...getPriceData('GBP', currency),
        label: 'پوند انگلیس',
      },
      {
        ...getPriceData('TRY', currency),
        label: 'لیر ترکیه',
      },
      {
        ...getPriceData('AED', currency),
        label: 'درهم امارات',
      },
      {
        ...getPriceData('CNY', currency),
        label: 'یوان چین',
      },
    ];

    // --------------------------------------------------
    // رسم سکشن‌ها
    // --------------------------------------------------

    let y = MARGIN + HEADER_HEIGHT;

    y = this.drawSection(
      ctx,
      'قیمت طلا',
      goldRows,
      MARGIN,
      y,
      INNER_WIDTH,
      fontFamily,
    );

    y += SECTION_GAP;

    y = this.drawSection(
      ctx,
      'قیمت سکه',
      coinRows,
      MARGIN,
      y,
      INNER_WIDTH,
      fontFamily,
    );

    y += SECTION_GAP;

    y = this.drawSection(
      ctx,
      'قیمت ارزهای شاخص',
      currencyRows,
      MARGIN,
      y,
      INNER_WIDTH,
      fontFamily,
    );

    // --------------------------------------------------
    // فوتر
    // --------------------------------------------------

    y += SECTION_GAP + 5;

    ctx.strokeStyle = dividerGradient;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN + 20, y);
    ctx.lineTo(WIDTH - MARGIN - 20, y);
    ctx.stroke();

    ctx.fillStyle = '#D4AF37';
    ctx.font = `bold 18px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.direction = 'ltr';
    ctx.fillText(
      '@atabak_gold',
      WIDTH / 2,
      y + 32,
    );

    ctx.fillStyle = '#E2E8F0';
    ctx.font = `bold 14px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.direction = 'rtl';
    ctx.fillText(
      'تلفن تماس: ۰۹۱۲۳۵۱۰۰۳۱',
      WIDTH / 2,
      y + 58,
    );

    ctx.fillStyle = '#718096';
    ctx.font = `12px ${fontFamily}`;
    ctx.fillText(
      'تحلیل، سیگنال و معاملات آنلاین طلا در کانال اتابک',
      WIDTH / 2,
      y + 80,
    );

    return canvas.toBuffer('image/png');
  }

  private drawSection(
    ctx: CanvasRenderingContext2D,
    title: string,
    rows: PriceRow[],
    x: number,
    y: number,
    width: number,
    fontFamily: string,
  ): number {
    const ROW_HEIGHT = 44;
    const TITLE_HEIGHT = 50;
    const PADDING = 12;

    const sectionHeight =
      TITLE_HEIGHT + rows.length * ROW_HEIGHT + PADDING;

    // پس‌زمینه سکشن
    const sectionGradient = ctx.createLinearGradient(
      x,
      y,
      x,
      y + sectionHeight,
    );

    sectionGradient.addColorStop(
      0,
      'rgba(255, 255, 255, 0.05)',
    );
    sectionGradient.addColorStop(
      1,
      'rgba(255, 255, 255, 0.01)',
    );

    this.roundRect(
      ctx,
      x,
      y,
      width,
      sectionHeight,
      18,
      sectionGradient,
      'rgba(212, 175, 55, 0.15)',
      1,
    );

    // نوار عنوان
    const titleBarGradient = ctx.createLinearGradient(
      x + 10,
      y,
      x + width - 10,
      y,
    );

    titleBarGradient.addColorStop(
      0,
      'rgba(212, 175, 55, 0)',
    );
    titleBarGradient.addColorStop(
      0.5,
      'rgba(212, 175, 55, 0.08)',
    );
    titleBarGradient.addColorStop(
      1,
      'rgba(212, 175, 55, 0)',
    );

    ctx.fillStyle = titleBarGradient;
    ctx.fillRect(
      x + 10,
      y + 4,
      width - 20,
      TITLE_HEIGHT - 10,
    );

    // عنوان سکشن
    ctx.fillStyle = '#D4AF37';
    ctx.font = `bold 16px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.direction = 'rtl';
    ctx.fillText(
      title,
      x + width / 2,
      y + 32,
    );

    let rowY = y + TITLE_HEIGHT;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];

      // پس‌زمینه ردیف‌های زوج
      if (index % 2 === 0) {
        this.roundRect(
          ctx,
          x + 8,
          rowY,
          width - 16,
          ROW_HEIGHT,
          8,
          'rgba(255, 255, 255, 0.02)',
          'transparent',
          0,
        );
      }

      // خط طلایی سمت راست
      this.roundRect(
        ctx,
        x + width - 15,
        rowY + 12,
        3,
        ROW_HEIGHT - 24,
        1.5,
        '#D4AF37',
        'transparent',
        0,
      );

      // عنوان قیمت
      ctx.fillStyle = '#CBD5E0';
      ctx.font = `14px ${fontFamily}`;
      ctx.textAlign = 'right';
      ctx.direction = 'rtl';
      ctx.fillText(
        row.label,
        x + width - 24,
        rowY + ROW_HEIGHT / 2 + 5,
      );

      let priceColor = '#FFFFFF';
      let trendSymbol = '';

      if (row.change !== undefined) {
        if (row.change > 0) {
          priceColor = '#48BB78';
          trendSymbol = '▲';
        } else if (row.change < 0) {
          priceColor = '#F56565';
          trendSymbol = '▼';
        }
      }

      const trendText = row.percent
        ? ` (${row.percent} ${trendSymbol})`
        : '';

      const textToDraw = `${row.value}${trendText}`;

      ctx.fillStyle = priceColor;
      ctx.font = `bold 15px ${fontFamily}`;
      ctx.textAlign = 'left';
      ctx.direction = 'rtl';
      ctx.fillText(
        textToDraw,
        x + 24,
        rowY + ROW_HEIGHT / 2 + 5,
      );

      rowY += ROW_HEIGHT;
    }

    return y + sectionHeight;
  }

  /**
   * تبدیل مقدار دریافتی API به عدد معتبر
   */
  private toFiniteNumber(
    value: unknown,
  ): number | undefined {
    if (
      value === null ||
      value === undefined ||
      value === ''
    ) {
      return undefined;
    }

    if (typeof value === 'string') {
      const normalizedValue = value
        .replace(/,/g, '')
        .replace(/٬/g, '')
        .trim();

      if (!normalizedValue) {
        return undefined;
      }

      const numericValue = Number(normalizedValue);

      return Number.isFinite(numericValue)
        ? numericValue
        : undefined;
    }

    const numericValue = Number(value);

    return Number.isFinite(numericValue)
      ? numericValue
      : undefined;
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
    fillStyle: string | CanvasGradient,
    strokeStyle: string | CanvasGradient,
    lineWidth: number,
  ): void {
    const safeRadius = Math.max(
      0,
      Math.min(radius, width / 2, height / 2),
    );

    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.lineTo(x + width - safeRadius, y);
    ctx.quadraticCurveTo(
      x + width,
      y,
      x + width,
      y + safeRadius,
    );
    ctx.lineTo(
      x + width,
      y + height - safeRadius,
    );
    ctx.quadraticCurveTo(
      x + width,
      y + height,
      x + width - safeRadius,
      y + height,
    );
    ctx.lineTo(x + safeRadius, y + height);
    ctx.quadraticCurveTo(
      x,
      y + height,
      x,
      y + height - safeRadius,
    );
    ctx.lineTo(x, y + safeRadius);
    ctx.quadraticCurveTo(
      x,
      y,
      x + safeRadius,
      y,
    );
    ctx.closePath();

    ctx.fillStyle = fillStyle;
    ctx.fill();

    if (
      strokeStyle !== 'transparent' &&
      lineWidth > 0
    ) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }
}
