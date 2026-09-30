import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { isMoneyUnit, MoneyUnit } from '../common/money';
import { parseSymbolUnits } from './env.validation';

export interface PlatformCredentials {
  botToken: string;
  channelId: string;
}

export interface PriceApiConfig {
  url: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  /** Unit in which the price API expresses its values. */
  sourceUnit: MoneyUnit;
  /** Optional per-symbol unit overrides (`PRICE_SYMBOL_UNITS`). */
  symbolUnits: Record<string, MoneyUnit>;
}

/**
 * Typed, validated view over the environment.
 *
 * All values are already validated at startup (`validateEnvironment`); the guards here are
 * defensive so a misuse of the config never results in `NaN` silently flowing into a message.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService) {}

  get port(): number {
    return this.readInteger('PORT', 3000);
  }

  get displayUnit(): MoneyUnit {
    return this.readMoneyUnit('PRICE_DISPLAY_UNIT', 'RIAL');
  }

  get deliveryTimeoutMs(): number {
    return this.readInteger('DELIVERY_TIMEOUT_MS', 20_000);
  }

  /** Bale is a required platform: missing credentials fail fast here too. */
  get bale(): PlatformCredentials {
    return {
      botToken: this.requireString('BALE_BOT_TOKEN'),
      channelId: this.requireString('BALE_CHANNEL_ID'),
    };
  }

  /** Telegram is optional and only enabled when both values are present. */
  get telegram(): PlatformCredentials | null {
    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    const channelId = this.configService.get<string>('TELEGRAM_CHANNEL_ID');

    if (!botToken || !channelId) {
      return null;
    }

    return { botToken, channelId };
  }

  get priceApi(): PriceApiConfig {
    return {
      url: this.requireString('PRICE_API_URL'),
      timeoutMs: this.readInteger('PRICE_API_TIMEOUT_MS', 20_000),
      maxAttempts: this.readInteger('PRICE_API_MAX_ATTEMPTS', 3),
      retryDelayMs: this.readInteger('PRICE_API_RETRY_DELAY_MS', 1500),
      sourceUnit: this.readMoneyUnit('PRICE_API_UNIT', 'RIAL'),
      symbolUnits: parseSymbolUnits(
        this.configService.get<string>('PRICE_SYMBOL_UNITS'),
      ),
    };
  }

  private requireString(key: string): string {
    const value = this.configService.get<string>(key);

    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`Missing required configuration value: ${key}`);
    }

    return String(value).trim();
  }

  private readInteger(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const value = Number(raw);

    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private readMoneyUnit(key: string, fallback: MoneyUnit): MoneyUnit {
    const raw = this.configService.get<string>(key)?.toUpperCase();

    return isMoneyUnit(raw) ? raw : fallback;
  }
}
