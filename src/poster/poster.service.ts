import { Injectable, Logger } from '@nestjs/common';
import { createCanvas, registerFont, CanvasRenderingContext2D } from 'canvas';
import * as path from 'path';

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

    const WIDTH = 568;
    const MARGIN = 24;
    const INNER_W = WIDTH - MARGIN * 2;

    const gold = data?.gold || [];
    const currency = data?.currency || [];

    const getPrice = (symbol: string, list: any[]): string => {
      const item = list.find(i => i.symbol === symbol);
      if (!item) return '---';
      return Number(item.price).toLocaleString('fa-IR');
    };

    const dateFa = new Date().toLocaleDateString('fa-IR');
    const timeFa = new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

    // --- محاسبه ارتفاع داینامیک ---
    const calcSectionHeight = (rowCount: number) =>
      48 + rowCount * (44 + 8) + 15;

    const goldH = calcSectionHeight(3);
    const coinH = calcSectionHeight(5);
    const currH = calcSectionHeight(7);
    const HEADER_H = 175;
    const FOOTER_H = 100;
    const GAP = 15;
    const HEIGHT = MARGIN + HEADER_H + goldH + GAP + coinH + GAP + currH + GAP + FOOTER_H + MARGIN;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    // --- پس‌زمینه ---
    const bgGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    bgGrad.addColorStop(0, '#141414');
    bgGrad.addColorStop(0.5, '#1c1c1c');
    bgGrad.addColorStop(1, '#0a0a0a');
    this.roundRect(ctx, 0, 0, WIDTH, HEIGHT, 32, bgGrad, '#d4af37', 2.5);

    // نوار طلایی بالا
    const topBar = ctx.createLinearGradient(MARGIN, 0, WIDTH - MARGIN, 0);
    topBar.addColorStop(0, 'transparent');
    topBar.addColorStop(0.3, '#d4af37');
    topBar.addColorStop(0.7, '#d4af37');
    topBar.addColorStop(1, 'transparent');
    ctx.fillStyle = topBar;
    ctx.fillRect(MARGIN, MARGIN, INNER_W, 3);

    // --- هدر ---
    ctx.shadowColor = '#d4af3788';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#d4af37';
    ctx.font = 'bold 38px Vazir';
    ctx.textAlign = 'center';
    ctx.fillText('طلای اتابک', WIDTH / 2, MARGIN + 55);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#888888';
    ctx.font = '15px Vazir';
    ctx.fillText('قیمت لحظه‌ای بازار طلا، سکه و ارز', WIDTH / 2, MARGIN + 82);

    // بج تاریخ
    this.roundRect(ctx, WIDTH / 2 - 135, MARGIN + 92, 270, 36, 18,
      'rgba(212,175,55,0.08)', '#d4af3755', 1);
    ctx.fillStyle = '#cccccc';
    ctx.font = '14px Vazir';
    ctx.fillText(`📅 ${dateFa}  —  ساعت ${timeFa}`, WIDTH / 2, MARGIN + 116);

    // خط جداکننده هدر
    const divGrad = ctx.createLinearGradient(MARGIN, 0, WIDTH - MARGIN, 0);
    divGrad.addColorStop(0, 'transparent');
    divGrad.addColorStop(0.2, '#d4af37');
    divGrad.addColorStop(0.8, '#d4af37');
    divGrad.addColorStop(1, 'transparent');
    ctx.strokeStyle = divGrad;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN, MARGIN + 140);
    ctx.lineTo(WIDTH - MARGIN, MARGIN + 140);
    ctx.stroke();
    ctx.setLineDash([]);

    // --- سکشن‌ها ---
    let y = MARGIN + HEADER_H;

    y = this.drawSection(ctx, 'قیمت طلا 💰', [
      { label: 'طلا ۱۸ عیار', value: getPrice('IR_GOLD_18K', gold) },
      { label: 'طلا ۲۴ عیار', value: getPrice('IR_GOLD_24K', gold) },
      { label: 'آبشده نقدی', value: getPrice('IR_GOLD_MELTED', gold) },
    ], ctx, MARGIN, y, INNER_W);

    y += GAP;
    y = this.drawSection(ctx, 'قیمت سکه 🪙', [
      { label: 'سکه امامی', value: getPrice('IR_COIN_EMAMI', gold) },
      { label: 'سکه تمام بهار', value: getPrice('IR_COIN_BAHAR', gold) },
      { label: 'نیم سکه', value: getPrice('IR_COIN_HALF', gold) },
      { label: 'ربع سکه', value: getPrice('IR_COIN_QUARTER', gold) },
      { label: 'سکه گرمی', value: getPrice('IR_COIN_1G', gold) },
    ], ctx, MARGIN, y, INNER_W);

    y += GAP;
    y = this.drawSection(ctx, 'قیمت ارز 💵', [
      { label: 'تتر', value: getPrice('USDT_IRT', currency) },
      { label: 'دلار آمریکا', value: getPrice('USD', currency) },
      { label: 'یورو', value: getPrice('EUR', currency) },
      { label: 'پوند', value: getPrice('GBP', currency) },
      { label: 'لیر ترکیه', value: getPrice('TRY', currency) },
      { label: 'درهم امارات', value: getPrice('AED', currency) },
      { label: 'یوآن چین', value: getPrice('CNY', currency) },
    ], ctx, MARGIN, y, INNER_W);

    // --- فوتر ---
    y += GAP + 8;
    const footerGrad = ctx.createLinearGradient(MARGIN, 0, WIDTH - MARGIN, 0);
    footerGrad.addColorStop(0, 'transparent');
    footerGrad.addColorStop(0.2, 'rgba(212,175,55,0.25)');
    footerGrad.addColorStop(0.8, 'rgba(212,175,55,0.25)');
    footerGrad.addColorStop(1, 'transparent');
    ctx.strokeStyle = footerGrad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y);
    ctx.lineTo(WIDTH - MARGIN, y);
    ctx.stroke();

    ctx.shadowColor = '#d4af3766';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#d4af37';
    ctx.font = 'bold 17px Vazir';
    ctx.textAlign = 'center';
    ctx.fillText('@atabak_gold', WIDTH / 2, y + 30);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#dddddd';
    ctx.font = '14px Vazir';
    ctx.fillText('09123510031', WIDTH / 2, y + 54);

    ctx.fillStyle = '#666666';
    ctx.font = '12px Vazir';
    ctx.fillText('تحلیل، خبر و قیمت لحظه‌ای بازار', WIDTH / 2, y + 74);

    // نوار طلایی پایین
    ctx.fillStyle = topBar;
    ctx.fillRect(MARGIN, HEIGHT - MARGIN - 3, INNER_W, 3);

    return canvas.toBuffer('image/png');
  }

  private drawSection(
    ctx: CanvasRenderingContext2D,
    title: string,
    rows: { label: string; value: string }[],
    _ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
  ): number {
    const ROW_HEIGHT = 44;
    const TITLE_HEIGHT = 48;
    const PADDING = 15;
    const sectionHeight = TITLE_HEIGHT + rows.length * (ROW_HEIGHT + 8) + PADDING;

    // پس‌زمینه سکشن با گرادیان
    const secGrad = ctx.createLinearGradient(x, y, x, y + sectionHeight);
    secGrad.addColorStop(0, 'rgba(255,255,255,0.06)');
    secGrad.addColorStop(1, 'rgba(255,255,255,0.02)');
    this.roundRect(ctx, x, y, width, sectionHeight, 18, secGrad, 'rgba(212,175,55,0.25)', 1);

    // نوار رنگی بالای سکشن
    const titleBar = ctx.createLinearGradient(x + 20, 0, x + width - 20, 0);
    titleBar.addColorStop(0, 'transparent');
    titleBar.addColorStop(0.3, '#d4af3733');
    titleBar.addColorStop(0.7, '#d4af3733');
    titleBar.addColorStop(1, 'transparent');
    ctx.fillStyle = titleBar;
    this.roundRect(ctx, x + 1, y + 1, width - 2, TITLE_HEIGHT - 8, 18, titleBar, 'transparent', 0);

    // عنوان سکشن
    ctx.shadowColor = '#d4af3755';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#d4af37';
    ctx.font = 'bold 18px Vazir';
    ctx.textAlign = 'center';
    ctx.fillText(title, x + width / 2, y + 30);
    ctx.shadowBlur = 0;

    // خط زیر عنوان
    ctx.strokeStyle = 'rgba(212,175,55,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 20, y + TITLE_HEIGHT - 5);
    ctx.lineTo(x + width - 20, y + TITLE_HEIGHT - 5);
    ctx.stroke();

    // ردیف‌های قیمت
    let rowY = y + TITLE_HEIGHT + 5;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // پس‌زمینه ردیف (یک‌در‌میان)
      if (i % 2 === 0) {
        this.roundRect(ctx, x + 8, rowY, width - 16, ROW_HEIGHT, 10,
          'rgba(255,255,255,0.04)', 'transparent', 0);
      }

      // خط طلایی سمت راست
      const accentGrad = ctx.createLinearGradient(0, rowY + 6, 0, rowY + ROW_HEIGHT - 6);
      accentGrad.addColorStop(0, '#d4af37');
      accentGrad.addColorStop(1, '#a07820');
      ctx.fillStyle = accentGrad;
      ctx.beginPath();
      ctx.roundRect(x + 10, rowY + 8, 4, ROW_HEIGHT - 16, 2);
      ctx.fill();

      // لیبل
      ctx.fillStyle = '#999999';
      ctx.font = '14px Vazir';
      ctx.textAlign = 'right';
      ctx.fillText(row.label, x + width - 24, rowY + ROW_HEIGHT / 2 + 5);

      // قیمت
      ctx.shadowColor = '#ffffff22';
      ctx.shadowBlur = 4;
      ctx.fillStyle = '#f0f0f0';
      ctx.font = 'bold 16px Vazir';
      ctx.textAlign = 'left';
      ctx.fillText(row.value, x + 24, rowY + ROW_HEIGHT / 2 + 5);
      ctx.shadowBlur = 0;

      rowY += ROW_HEIGHT + 8;
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
