import { Injectable, Logger } from '@nestjs/common';
import { createCanvas, registerFont, CanvasRenderingContext2D } from 'canvas';
import * as path from 'path';

interface PriceRow {
  label: string;
  value: string;
  change?: number; // مقدار تغییر عددی (مثلا ۲۰۰۰۰ یا -۱۵۰۰)
  percent?: string; // درصد تغییر (مثلا "۰.۵٪+" یا "۱.۲٪-")
}

@Injectable()
export class PosterService {
  private readonly logger = new Logger(PosterService.name);
  private fontRegistered = false;

  private registerFontOnce() {
    if (this.fontRegistered) return;
    try {
      const fontPath = path.resolve(process.cwd(), 'assets', 'Vazir.ttf');
      registerFont(fontPath, { family: 'Vazir' });
      this.fontRegistered = true;
      this.logger.log('Font registered successfully.');
    } catch (err) {
      this.logger.error(`Could not register font: ${err.message}`);
    }
  }

  async generatePricePoster(data: any): Promise<Buffer> {
    this.registerFontOnce();

    const WIDTH = 600; // افزایش اندک عرض برای خوانایی بهتر در موبایل
    const MARGIN = 28;
    const INNER_W = WIDTH - MARGIN * 2;

    const gold = data?.gold || [];
    const currency = data?.currency || [];

    const getPriceData = (symbol: string, list: any[]): PriceRow => {
      const item = list.find(i => i.symbol === symbol);
      if (!item) return { label: '', value: '---' };
      
      const formattedPrice = Number(item.price).toLocaleString('fa-IR');
      
      // استخراج درصد تغییرات در صورت وجود در API شما
      let percent: string | undefined = undefined;
      let change: number | undefined = undefined;
      if (item.change !== undefined) {
        change = Number(item.change);
        const prefix = change > 0 ? '+' : '';
        percent = `${Number(item.percent || 0).toLocaleString('fa-IR')}%${prefix}`;
      }

      return {
        label: '', // بعدا ست می‌شود
        value: formattedPrice,
        change,
        percent
      };
    };

    const dateFa = new Date().toLocaleDateString('fa-IR');
    const timeFa = new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

    // محاسبه ارتفاع داینامیک براساس تعداد ردیف‌ها
    const calcSectionHeight = (rowCount: number) => 54 + rowCount * 48 + 12;

    const goldH = calcSectionHeight(3);
    const coinH = calcSectionHeight(5);
    const currH = calcSectionHeight(7);
    const HEADER_H = 180;
    const FOOTER_H = 110;
    const GAP = 18;
    const HEIGHT = MARGIN + HEADER_H + goldH + GAP + coinH + GAP + currH + GAP + FOOTER_H + MARGIN;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    // --- پس‌زمینه دارک و لوکس ---
    const bgGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    bgGrad.addColorStop(0, '#0F0F12');
    bgGrad.addColorStop(0.5, '#15161E');
    bgGrad.addColorStop(1, '#08080A');
    this.roundRect(ctx, 0, 0, WIDTH, HEIGHT, 28, bgGrad, '#D4AF37', 2);

    // خطوط هاله طلایی در پس‌زمینه (Glow Effect برای ظاهر بیزینسی لوکس)
    ctx.save();
    ctx.globalAlpha = 0.03;
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth = 120;
    ctx.beginPath();
    ctx.arc(WIDTH / 2, 0, 180, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // --- هدر پوستر ---
    ctx.shadowColor = 'rgba(212, 175, 55, 0.4)';
    ctx.shadowBlur = 15;
    ctx.fillStyle = '#D4AF37';
    ctx.font = 'bold 36px Vazir';
    ctx.textAlign = 'center';
    ctx.fillText('طلای اتابک', WIDTH / 2, MARGIN + 52);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#A0AEC0';
    ctx.font = '14px Vazir';
    ctx.fillText('مرجع قیمت لحظه‌ای بازار طلا، سکه و ارز', WIDTH / 2, MARGIN + 80);

    // بج شیک تاریخ و ساعت
    this.roundRect(ctx, WIDTH / 2 - 140, MARGIN + 94, 280, 38, 12,
      'rgba(212, 175, 55, 0.06)', 'rgba(212, 175, 55, 0.25)', 1);
    ctx.fillStyle = '#E2E8F0';
    ctx.font = 'bold 13px Vazir';
    ctx.fillText(`📅  ${dateFa}   |   ⏰  ساعت  ${timeFa}`, WIDTH / 2, MARGIN + 118);

    // خط جداکننده هدر (گرادیان محو شونده)
    const divGrad = ctx.createLinearGradient(MARGIN, 0, WIDTH - MARGIN, 0);
    divGrad.addColorStop(0, 'transparent');
    divGrad.addColorStop(0.3, 'rgba(212, 175, 55, 0.4)');
    divGrad.addColorStop(0.7, 'rgba(212, 175, 55, 0.4)');
    divGrad.addColorStop(1, 'transparent');
    ctx.strokeStyle = divGrad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN + 20, MARGIN + 152);
    ctx.lineTo(WIDTH - MARGIN - 20, MARGIN + 152);
    ctx.stroke();

    // --- سکشن‌ها ---
    let y = MARGIN + HEADER_H;

    // ۱. طلا
    const goldRows = [
      { ...getPriceData('IR_GOLD_18K', gold), label: 'طلای ۱۸ عیار (گرم)' },
      { ...getPriceData('IR_GOLD_24K', gold), label: 'طلای ۲۴ عیار (گرم)' },
      { ...getPriceData('IR_GOLD_MELTED', gold), label: 'مظنه آبشده نقدی' },
    ];
    y = this.drawSection(ctx, 'قیمت طلا 💰', goldRows, MARGIN, y, INNER_W);

    y += GAP;
    // ۲. سکه
    const coinRows = [
      { ...getPriceData('IR_COIN_EMAMI', gold), label: 'سکه امامی (طرح جدید)' },
      { ...getPriceData('IR_COIN_BAHAR', gold), label: 'سکه بهار آزادی (طرح قدیم)' },
      { ...getPriceData('IR_COIN_HALF', gold), label: 'نیم سکه بهار آزادی' },
      { ...getPriceData('IR_COIN_QUARTER', gold), label: 'ربع سکه بهار آزادی' },
      { ...getPriceData('IR_COIN_1G', gold), label: 'سکه گرمی بانک مرکزی' },
    ];
    y = this.drawSection(ctx, 'قیمت سکه 🪙', coinRows, MARGIN, y, INNER_W);

    y += GAP;
    // ۳. ارزها
    const currencyRows = [
      { ...getPriceData('USDT_IRT', currency), label: 'تتر (دلار دیجیتال)' },
      { ...getPriceData('USD', currency), label: 'دلار آمریکا (تهران)' },
      { ...getPriceData('EUR', currency), label: 'یورو' },
      { ...getPriceData('GBP', currency), label: 'پوند انگلیس' },
      { ...getPriceData('TRY', currency), label: 'لیر ترکیه' },
      { ...getPriceData('AED', currency), label: 'درهم امارات' },
      { ...getPriceData('CNY', currency), label: 'یوان چین' },
    ];
    y = this.drawSection(ctx, 'قیمت ارزهای شاخص 💵', currencyRows, MARGIN, y, INNER_W);

    // --- فوتر بیزینسی با خوانایی بالا ---
    y += GAP + 5;
    ctx.strokeStyle = divGrad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN + 20, y);
    ctx.lineTo(WIDTH - MARGIN - 20, y);
    ctx.stroke();

    // آیدی کانال با فونت برجسته طلایی
    ctx.fillStyle = '#D4AF37';
    ctx.font = 'bold 18px Vazir';
    ctx.textAlign = 'center';
    ctx.fillText('📢  @atabak_gold', WIDTH / 2, y + 32);

    // شماره تماس
    ctx.fillStyle = '#E2E8F0';
    ctx.font = 'bold 14px Vazir';
    ctx.fillText('📞  تلفن تماس: ۰۹۱۲۳۵۱۰۰۳۱', WIDTH / 2, y + 58);

    // توضیح نهایی
    ctx.fillStyle = '#718096';
    ctx.font = '12px Vazir';
    ctx.fillText('تحلیل، سیگنال و معاملات آنلاین طلا در کانال اتـابک', WIDTH / 2, y + 80);

    return canvas.toBuffer('image/png');
  }

  private drawSection(
    ctx: CanvasRenderingContext2D,
    title: string,
    rows: PriceRow[],
    x: number,
    y: number,
    width: number,
  ): number {
    const ROW_HEIGHT = 44;
    const TITLE_HEIGHT = 50;
    const PADDING = 12;
    const sectionHeight = TITLE_HEIGHT + rows.length * ROW_HEIGHT + PADDING;

    // بک‌گراند شیک و مدرن شیشه‌ای نیمه شفاف برای هر کارت
    const secGrad = ctx.createLinearGradient(x, y, x, y + sectionHeight);
    secGrad.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
    secGrad.addColorStop(1, 'rgba(255, 255, 255, 0.01)');
    this.roundRect(ctx, x, y, width, sectionHeight, 18, secGrad, 'rgba(212, 175, 55, 0.15)', 1);

    // تایتل بار بالایی کارت‌ها
    const titleBarGrad = ctx.createLinearGradient(x + 10, y, x + width - 10, y);
    titleBarGrad.addColorStop(0, 'transparent');
    titleBarGrad.addColorStop(0.5, 'rgba(212, 175, 55, 0.08)');
    titleBarGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = titleBarGrad;
    ctx.fillRect(x + 10, y + 4, width - 20, TITLE_HEIGHT - 10);

    // هدر کارت
    ctx.fillStyle = '#D4AF37';
    ctx.font = 'bold 16px Vazir';
    ctx.textAlign = 'center';
    ctx.fillText(title, x + width / 2, y + 32);

    let rowY = y + TITLE_HEIGHT;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // پس‌زمینه ردیف‌های زوج برای ایجاد ریتم بصری زیباتر
      if (i % 2 === 0) {
        this.roundRect(ctx, x + 8, rowY, width - 16, ROW_HEIGHT, 8,
          'rgba(255, 255, 255, 0.02)', 'transparent', 0);
      }

      // خط رنگی کوچک سمت راست برای هویت بصری
      ctx.fillStyle = '#D4AF37';
      ctx.beginPath();
      ctx.roundRect(x + 12, rowY + 12, 3, ROW_HEIGHT - 24, 1.5);
      ctx.fill();

      // لیبل (راست چین)
      ctx.fillStyle = '#CBD5E0';
      ctx.font = '14px Vazir';
      ctx.textAlign = 'right';
      ctx.fillText(row.label, x + width - 24, rowY + ROW_HEIGHT / 2 + 5);

      // رنگ‌آمیزی بر اساس صعودی/نزولی بودن تغییرات در صورت وجود
      let priceColor = '#FFFFFF';
      let trendSymbol = '';
      
      if (row.change !== undefined) {
        if (row.change > 0) {
          priceColor = '#48BB78'; // سبز صعودی
          trendSymbol = ' ▲ ';
        } else if (row.change < 0) {
          priceColor = '#F56565'; // قرمز نزولی
          trendSymbol = ' ▼ ';
        }
      }

      // مقدار قیمت (چپ چین)
      ctx.fillStyle = priceColor;
      ctx.font = 'bold 15px Vazir';
      ctx.textAlign = 'left';
      
      // اگر تغییرات درصدی وجود دارد، آن را کنار قیمت نمایش می‌دهیم
      const textToDraw = row.percent 
        ? `${row.value} (${row.percent}${trendSymbol})` 
        : row.value;

      ctx.fillText(textToDraw, x + 24, rowY + ROW_HEIGHT / 2 + 5);

      rowY += ROW_HEIGHT;
    }

    return y + sectionHeight;
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    width: number, height: number,
    radius: number,
    fillStyle: string | CanvasGradient,
    strokeStyle: string | CanvasGradient,
    lineWidth: number,
  ) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();

    if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }
    if (strokeStyle && strokeStyle !== 'transparent' && lineWidth > 0) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }
}
