import { Injectable, Logger } from '@nestjs/common';
import * as puppeteer from 'puppeteer-core'; 
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class PosterService {
  private readonly logger = new Logger(PosterService.name);

  async generatePricePoster(data: any): Promise<Buffer> {
    let browser;
    try {
      this.logger.log('Generating dynamic poster with Puppeteer...');
      
      // --- خواندن فونت و تبدیل به Base64 برای اطمینان ۱۰۰٪ از اعمال شدن ---
      const fontPath = path.resolve(process.cwd(), 'assets', 'Vazir.ttf');
      let fontBase64 = '';
      try {
        fontBase64 = fs.readFileSync(fontPath).toString('base64');
      } catch (err) {
        this.logger.error(`Could not read font file at ${fontPath}: ${err.message}`);
      }
      
      const htmlContent = this.getHtmlTemplate(data, fontBase64);
      
      // ساخت داینامیک تنظیمات Puppeteer
            const launchOptions: any = {
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox', 
          '--disable-dev-shm-usage', // اضافه شد برای جلوگیری از کرش در داکر
          '--disable-gpu',           // اضافه شد برای بهینه‌سازی در سرور
          '--font-render-hinting=none',
        ],
        headless: 'new', // مقدار 'new' برای نسخه‌های جدید پاپتیر توصیه می‌شود
      };

      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      } else {
        // در داکر فایل ما، کروم در مسیر استاندارد نصب می‌شود
        // اگر در لوکال ویندوز هستید و کروم دارید، کانال chrome کار می‌کند
        launchOptions.channel = 'chrome';
      }

      this.logger.log(`Launching Puppeteer with settings: ${JSON.stringify(launchOptions)}`);

      browser = await puppeteer.launch(launchOptions);
      const page = await browser.newPage();
      
      await page.setViewport({ width: 800, height: 1200, deviceScaleFactor: 2 });

      // انتظار برای لود کامل محتوا و استایل‌ها
      await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

      const element = await page.$('.poster');
      if (!element) throw new Error('Poster element not found');

      const imageBuffer = await element.screenshot({ 
        type: 'png',
        omitBackground: true 
      }) as Buffer;

      return imageBuffer;
    } catch (error) {
      this.logger.error(`Poster Generation Error: ${error.message}`);
      throw error;
    } finally {
      if (browser) await browser.close();
    }
  }

  private getHtmlTemplate(data: any, fontBase64: string): string {
    const gold = data?.gold || [];
    const currency = data?.currency || [];
    const global = data?.global || [];

    const getPrice = (symbol: string, list: any[]) => {
      const item = list.find(i => i.symbol === symbol);
      if (!item) return '---';
      return Number(item.price).toLocaleString('fa-IR');
    };

    const dateFa = new Date().toLocaleDateString('fa-IR');
    const timeFa = new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

    return `
<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <style>
        /* تزریق مستقیم فونت به صورت Base64 برای رفع مشکل عدم نمایش */
        @font-face {
            font-family: 'Vazir';
            src: url(data:font/ttf;charset=utf-8;base64,${fontBase64}) format('truetype');
            font-weight: normal;
            font-style: normal;
        }

        :root {
            --gold: #d4af37;
            --dark-bg: #0d0d0d;
            --card-bg: rgba(255, 255, 255, 0.05);
            --border-color: rgba(212, 175, 55, 0.3);
            --text-main: #ffffff;
            --text-muted: #a0a0a0;
        }

        body {
            margin: 0; 
            padding: 0;
            background-color: transparent; 
            font-family: 'Vazir', 'Tahoma', sans-serif;
            display: flex; 
            justify-content: center;
            align-items: flex-start;
            overflow: hidden;
        }

        .poster {
            width: 600px;
            background: linear-gradient(180deg, #1a1a1a 0%, #000000 100%);
            border: 2px solid var(--gold);
            border-radius: 35px;
            padding: 30px;
            box-sizing: border-box; 
            position: relative;
        }

        .header {
            text-align: center;
            margin-bottom: 25px;
            border-bottom: 1px dashed var(--gold);
            padding-bottom: 20px;
        }

        .header h1 {
            color: var(--gold);
            font-size: 38px;
            margin: 0;
            text-shadow: 0 0 15px rgba(212, 175, 55, 0.4);
        }

        .header p { font-size: 16px; color: var(--text-muted); margin: 8px 0; }

        .time-badge {
            display: inline-block;
            background: rgba(212, 175, 55, 0.1);
            border: 1px solid var(--gold);
            border-radius: 20px;
            padding: 6px 20px;
            font-size: 14px;
            color: #fff;
            margin-top: 10px;
        }

        .main-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
        }

        .section {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 20px;
            padding: 15px;
        }

        .section-title {
            display: flex; align-items: center; justify-content: center;
            color: var(--gold); font-weight: bold;
            margin-bottom: 15px; font-size: 18px;
            border-bottom: 1px solid rgba(212, 175, 55, 0.2);
            padding-bottom: 10px;
        }

        .price-row {
            display: flex; justify-content: space-between; align-items: center;
            background: rgba(255, 255, 255, 0.03);
            margin-bottom: 8px; padding: 12px;
            border-radius: 12px; border-right: 4px solid var(--gold);
        }

        .price-label { font-size: 14px; color: var(--text-muted); }
        .price-value { font-size: 17px; font-weight: bold; color: #fff; }

        .bottom-grid {
            display: grid;
            grid-template-columns: 0.8fr 1.2fr;
            gap: 15px;
            margin-top: 15px;
        }

        .bubble-row {
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 12px;
            background: rgba(255,255,255,0.02);
            margin-bottom: 6px;
            border-radius: 10px;
        }

        .footer {
            margin-top: 30px; text-align: center;
            font-size: 13px; color: var(--gold);
            border-top: 1px solid rgba(212, 175, 55, 0.2);
            padding-top: 20px;
        }

        .ins-box {
            display: flex; flex-direction: column;
            align-items: center; justify-content: center; height: 100px;
        }

        .ins-value { font-size: 34px; font-weight: bold; color: var(--gold); }
    </style>
</head>
<body>

<div class="poster">
    <div class="header">
        <h1> طلای اتابک</h1>
        <p>قیمت لحظه‌ای بازار طلا، سکه و ارز</p>
        <div class="time-badge">
            📅 ${dateFa} - ساعت ${timeFa}
        </div>
    </div>

    <div class="main-grid">
        <div class="section">
            <div class="section-title">💰 قیمت طلا</div>
            <div class="price-row">
                <span class="price-value">${getPrice('IR_GOLD_18K', gold)}</span>
                <span class="price-label">طلا ۱۸ عیار</span>
            </div>
            <div class="price-row">
                <span class="price-value">${getPrice('IR_GOLD_24K', gold)}</span>
                <span class="price-label">طلا ۲۴ عیار</span>
            </div>
            <div class="price-row">
                <span class="price-value">${getPrice('IR_GOLD_MELTED', gold)}</span>
                <span class="price-label">آبشده نقدی</span>
            </div>
        </div>

        <div class="section">
            <div class="section-title">🪙 قیمت سکه</div>
            <div class="price-row">
                <span class="price-value">${getPrice('IR_COIN_EMAMI', gold)}</span>
                <span class="price-label">سکه امامی</span>
            </div>
            <div class="price-row">
                <span class="price-value">${getPrice('IR_COIN_BAHAR', gold)}</span>
                <span class="price-label">سکه تمام بهار</span>
            </div>
            <div class="price-row">
                <span class="price-value">${getPrice('IR_COIN_HALF', gold)}</span>
                <span class="price-label">نیم‌ سکه</span>
            </div>
            <div class="price-row">
                <span class="price-value">${getPrice('IR_COIN_QUARTER', gold)}</span>
                <span class="price-label">ربع سکه</span>
            </div>
            <div class="price-row">
                <span class="price-value">${getPrice('IR_COIN_1G', gold)}</span>
                <span class="price-label">سکه گرمی</span>
            </div>
        </div>
    </div>

    <div class="bottom-grid">
        <div class="section">
            <div class="section-title">🌍 انس جهانی</div>
            <div class="ins-box">
                <span class="ins-value">${getPrice('XAUUSD', gold)}</span>
                <span style="color: var(--text-muted); font-size: 12px; margin-top:5px;">دلار آمریکا</span>
            </div>
        </div>

        <div class="section">
            <div class="section-title">💵 قیمت ارز</div>
            <div class="bubble-row">
                <span class="price-value">${getPrice('USDT_IRT', currency)}</span>
                <span class="price-label">تتر</span>
            </div>
            <div class="bubble-row">
                <span class="price-value">${getPrice('USD', currency)}</span>
                <span class="price-label">دلار آمریکا</span>
            </div>
            <div class="bubble-row">
                <span class="price-value">${getPrice('EUR', currency)}</span>
                <span class="price-label">یورو</span>
            </div>
            <div class="bubble-row">
                <span class="price-value">${getPrice('GBP', currency)}</span>
                <span class="price-label">پوند</span>
            </div>
            <div class="bubble-row">
                <span class="price-value">${getPrice('TRY', currency)}</span>
                <span class="price-label">لیر ترکیه</span>
            </div>
            <div class="bubble-row">
                <span class="price-value">${getPrice('AED', currency)}</span>
                <span class="price-label">درهم امارات</span>
            </div>
            <div class="bubble-row">
                <span class="price-value">${getPrice('CNY', currency)}</span>
                <span class="price-label">یوآن چین</span>
            </div>
        </div>
    </div>

    <div class="footer">
        <strong>@atabak_gold</strong> <br> <strong>09123510031</strong><br>
        <span style="opacity: 0.8; font-size: 11px;">تحلیل، خبر و قیمت لحظه‌ای بازار</span>
    </div>
</div>

</body>
</html>
    `;
  }
}