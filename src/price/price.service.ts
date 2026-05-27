import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * دریافت داده‌های بازار از API
   * در صورت بروز خطا، لاگ ثبت شده و استثنا پرتاب می‌شود
   */
  async getPrices(): Promise<any> {
    const url = this.configService.get<string>('PRICE_API_URL');

    if (!url) {
      this.logger.error(
        'PRICE_API_URL is not defined in environment variables',
      );
      throw new InternalServerErrorException(
        'API URL configuration is missing',
      );
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          timeout: 15000,
          headers: { Accept: 'application/json' },
        }),
      );

      return response.data;
    } catch (error: any) {
      this.logger.error(`Failed to fetch prices: ${error.message}`);
      // پرتاب خطا برای اینکه بات بداند دیتایی دریافت نشده است
      throw new Error('Could not fetch market data from API');
    }
  }
}
