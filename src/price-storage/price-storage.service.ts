// price-storage.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface PriceRecord {
  time: string; // مثلا '14:30'
  price: number;
}

@Injectable()
export class PriceStorageService {
  private readonly logger = new Logger(PriceStorageService.name);
  private readonly filePath = path.join(process.cwd(), 'daily-prices.json');

  // ذخیره قیمت جدید برای یک نماد خاص
  async savePrice(symbol: string, price: number, time: string) {
    try {
      const data = await this.getAllData();
      if (!data[symbol]) {
        data[symbol] = [];
      }
      
      data[symbol].push({ time, price });
      await fs.promises.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Error saving price to file', error);
    }
  }

  // خواندن کل داده‌های ذخیره شده امروز
  async getAllData(): Promise<Record<string, PriceRecord[]>> {
    try {
      if (!fs.existsSync(this.filePath)) {
        return {};
      }
      const content = await fs.promises.readFile(this.filePath, 'utf-8');
      return JSON.parse(content || '{}');
    } catch (error) {
      this.logger.error('Error reading price file', error);
      return {};
    }
  }

  // پاک کردن فایل در انتهای شب (بعد از ارسال نمودار) برای روز بعد
  async clearDailyData() {
    try {
      if (fs.existsSync(this.filePath)) {
        await fs.promises.unlink(this.filePath);
        this.logger.log('Daily price storage cleared for next day.');
      }
    } catch (error) {
      this.logger.error('Error clearing price file', error);
    }
  }
}
