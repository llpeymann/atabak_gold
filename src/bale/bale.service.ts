import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import FormData from 'form-data';
import { Readable } from 'stream';

@Injectable()
export class BaleService {
  private readonly logger = new Logger(BaleService.name);
  private readonly PHOTO_TIMEOUT = 30000;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private getBaseUrl(): string {
    const token = this.configService.get<string>('BALE_BOT_TOKEN');
    if (!token) {
      this.logger.error('BALE_BOT_TOKEN is not defined');
      throw new InternalServerErrorException('Bot token configuration is missing');
    }
    return `https://tapi.bale.ai/bot${token}`;
  }

  async sendMessage(chatId: string, text: string): Promise<any> {
  const url = `${this.getBaseUrl()}/sendMessage`;
  try {
    const response = await firstValueFrom(
      this.httpService.post(url, {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      })
    );
    
    // اضافه کردن لاگ موفقیت
    this.logger.log(`✅ Message successfully sent to channel: ${chatId}`);
    
    return response.data;
  } catch (error) {
    this.logger.error(`❌ Failed to send message to ${chatId}: ${error.message}`);
    throw error;
  }
}


  // ====================================================================
  //  متد اصلاح شده برای ارسال موفق تصویر
  // ====================================================================
  async sendPhotoBuffer(
    chatId: string,
    buffer: Buffer,
    caption: string,
  ): Promise<any> {
    if (!chatId) throw new Error('chatId is required');
    if (!buffer) throw new Error('photo buffer is empty');

    const url = `${this.getBaseUrl()}/sendPhoto`;

    try {
      // ۱. تبدیل بافر به استریم برای سازگاری کامل با Form-Data و API بله
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);

      // ۲. ساخت فرم‌دیتا
      const formData = new FormData();
      formData.append('chat_id', chatId);
      
      // اختصاص نام فایل و هدرهای لازم برای بافر
      formData.append('photo', stream, {
        filename: 'poster.png',
        contentType: 'image/png',
        knownLength: buffer.length // کمک به ارسال سریع‌تر و دقیق‌تر
      });
      
      formData.append('caption', caption);

      // ۳. ارسال درخواست
      const response = await firstValueFrom(
        this.httpService.post(url, formData, {
          timeout: this.PHOTO_TIMEOUT,
          headers: {
            ...formData.getHeaders(), // این هدر شامل Content-Type صحیح به همراه Boundary است
          },
        }),
      );

      this.logger.log('✅ Photo sent successfully to Bale');
      return response.data;
    } catch (error: any) {
      this.logger.error(`❌ Failed to send photo: ${error?.message}`);
      
      if (error.response?.data) {
        this.logger.error(`Bale API Detail: ${JSON.stringify(error.response.data)}`);
      }
      throw new Error('Could not send photo to Bale');
    }
  }
}
