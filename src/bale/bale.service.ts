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
  private readonly PHOTO_TIMEOUT = 40000;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private getUrls() {
    const baleToken = this.configService.get<string>('BALE_BOT_TOKEN');
    const tgToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');

    return {
      bale: `https://tapi.bale.ai/bot${baleToken}`,
      telegram: `https://api.telegram.org/bot${tgToken}`
    };
  }

  async sendMessage(chatId: string, text: string): Promise<any> {
    const urls = this.getUrls();
    const tgChatId = this.configService.get<string>('TELEGRAM_CHANNEL_ID');

    const promises: Promise<any>[] = [];

    // ارسال به بله
    if (this.configService.get('BALE_BOT_TOKEN')) {
        promises.push(
          firstValueFrom(this.httpService.post(`${urls.bale}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
          })).then(() => this.logger.log(`✅ Sent to Bale: ${chatId}`))
             .catch((err) => this.logger.error(`❌ Bale Error: ${err.message}`))
        );
    }

    // ارسال به تلگرام
    if (this.configService.get('TELEGRAM_BOT_TOKEN') && tgChatId) {
      promises.push(
        firstValueFrom(this.httpService.post(`${urls.telegram}/sendMessage`, {
          chat_id: tgChatId,
          text,
          parse_mode: 'HTML',
        })).then(() => this.logger.log(`✅ Sent to Telegram: ${tgChatId}`))
           .catch((err) => this.logger.error(`❌ Telegram Error: ${err.message}`))
      );
    }

    return Promise.allSettled(promises);
  }

  async sendPhotoBuffer(
    chatId: string,
    buffer: Buffer,
    caption: string,
  ): Promise<any> {
    const urls = this.getUrls();
    const tgChatId = this.configService.get<string>('TELEGRAM_CHANNEL_ID');
    
    const results: Promise<any>[] = [];

    // ارسال به بله
    if (this.configService.get('BALE_BOT_TOKEN')) {
        results.push(this.executeSendPhoto(urls.bale, chatId, buffer, caption, 'Bale'));
    }

    // ارسال به تلگرام
    if (this.configService.get('TELEGRAM_BOT_TOKEN') && tgChatId) {
        results.push(this.executeSendPhoto(urls.telegram, tgChatId, buffer, caption, 'Telegram'));
    }

    return Promise.allSettled(results);
  }

  private async executeSendPhoto(baseUrl: string, targetId: string, buffer: Buffer, caption: string, platformName: string): Promise<void> {
    try {
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);

      const formData = new FormData();
      formData.append('chat_id', targetId);
      formData.append('photo', stream, {
        filename: 'chart.png',
        contentType: 'image/png',
        knownLength: buffer.length
      });
      formData.append('caption', caption);
      formData.append('parse_mode', 'HTML');

      await firstValueFrom(
        this.httpService.post(`${baseUrl}/sendPhoto`, formData, {
          timeout: this.PHOTO_TIMEOUT,
          headers: { ...formData.getHeaders() },
        }),
      );
      this.logger.log(`✅ Photo sent successfully to ${platformName}`);
    } catch (error: any) {
      this.logger.error(`❌ Failed to send photo to ${platformName}: ${error?.message}`);
    }
  }
}
