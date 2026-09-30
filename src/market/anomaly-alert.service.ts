import { Injectable, Logger } from '@nestjs/common';

import { BaleService } from '../bale/bale.service';
import { AppConfigService } from '../config/app-config.service';
import { MESSAGE_DIVIDER } from '../common/branding';
import { escapeHtml } from '../common/html';
import { formatMoney, formatPercentFa } from '../common/money';
import { tehranTimeFa } from '../common/tehran-time';
import { PriceEvaluation } from './market.types';

interface CooldownEntry {
  firstSeenAt: number;
  lastSentAt: number;
  suppressed: number;
}

/**
 * Operational alerting for rejected anomalies.
 *
 * This is an *admin* alert (never published to the public channel) and it reuses the existing
 * delivery capability, sending to `ANOMALY_ALERT_CHAT_ID` when configured. When that variable is
 * not set the alert is still emitted as an error-level log line — anomalies are never silent.
 *
 * Spam protection: alerts are de-duplicated per `symbol + reason` with a cooldown window
 * (`ANOMALY_ALERT_COOLDOWN_MINUTES`, default 30). While the cooldown is active the occurrences are
 * counted, and the next alert that is actually sent reports how many were suppressed. Only the
 * last *rejected* value is kept for the suppressed window (no unbounded memory growth).
 * In-memory only: state is intentionally not persisted, because a restart naturally re-arms alerts.
 */
@Injectable()
export class AnomalyAlertService {
  private readonly logger = new Logger(AnomalyAlertService.name);
  private readonly cooldowns = new Map<string, CooldownEntry>();

  constructor(
    private readonly config: AppConfigService,
    private readonly baleService: BaleService,
  ) {}

  /**
   * Report a rejected anomaly. Returns whether an alert was actually delivered/sent
   * (`false` means it was suppressed by the cooldown).
   */
  async reportAnomaly(
    evaluation: PriceEvaluation,
    now = new Date(),
  ): Promise<boolean> {
    const key = `${evaluation.symbol}:${evaluation.reason ?? 'UNKNOWN'}`;
    const nowMs = now.getTime();
    const cooldownMs = this.config.anomalyAlertCooldownMinutes * 60_000;
    const entry = this.cooldowns.get(key);

    if (entry && nowMs - entry.lastSentAt < cooldownMs) {
      entry.suppressed += 1;
      this.logger.warn(
        `Anomaly alert suppressed (cooldown) for ${key} — ${entry.suppressed} occurrence(s) ` +
          'since the last alert.',
      );
      return false;
    }

    const suppressed = entry ? entry.suppressed : 0;
    this.cooldowns.set(key, {
      firstSeenAt: entry?.firstSeenAt ?? nowMs,
      lastSentAt: nowMs,
      suppressed: 0,
    });

    const message = this.buildMessage(evaluation, now, suppressed);
    const chatId = this.config.anomalyAlertChatId;

    if (!chatId) {
      this.logger.error(
        `🚨 PRICE ANOMALY (no ANOMALY_ALERT_CHAT_ID configured, log only) — ` +
          this.buildLogSummary(evaluation),
      );
      return true;
    }

    const results = await this.baleService.sendMessageTo(chatId, message);
    const delivered = results.some((result) => result.success);

    if (!delivered) {
      this.logger.error(
        `Could not deliver the anomaly alert to ${chatId} — ` +
          this.buildLogSummary(evaluation),
      );
    }

    return delivered;
  }

  /** Test/introspection helper. */
  get activeCooldowns(): number {
    return this.cooldowns.size;
  }

  private buildLogSummary(evaluation: PriceEvaluation): string {
    const value = evaluation.rejectedValue ?? null;
    const unit = evaluation.unit;

    return (
      `${evaluation.label} (${evaluation.symbol}) | previous: ` +
      `${evaluation.previousPrice === null ? 'n/a' : formatMoney(evaluation.previousPrice, this.displayUnitFor(evaluation))}` +
      ` | received: ${value === null ? 'n/a' : formatMoney(value, this.displayUnitFor(evaluation))}` +
      ` | change: ${formatPercentFa(evaluation.percentageChange) ?? 'n/a'}` +
      ` | reason: ${evaluation.reason ?? 'UNKNOWN'} | ${evaluation.detail ?? ''} | unit: ${unit}`
    );
  }

  private buildMessage(
    evaluation: PriceEvaluation,
    now: Date,
    suppressed: number,
  ): string {
    const unit = this.displayUnitFor(evaluation);
    const lines: string[] = [
      '🚨 <b>هشدار ناهنجاری قیمت</b>',
      MESSAGE_DIVIDER,
      `🔖 نماد: ${escapeHtml(evaluation.label)} (${escapeHtml(evaluation.symbol)})`,
      `📌 قیمت قبلی: ${
        evaluation.previousPrice === null
          ? '—'
          : escapeHtml(formatMoney(evaluation.previousPrice, unit))
      }`,
      `📥 مقدار دریافتی: ${
        evaluation.rejectedValue === undefined
          ? '—'
          : escapeHtml(formatMoney(evaluation.rejectedValue, unit))
      }`,
      `📈 تغییر: ${escapeHtml(formatPercentFa(evaluation.percentageChange) ?? '—')}`,
      `⛔️ وضعیت: رد شد (REJECTED)`,
      `❗️ دلیل: ${escapeHtml(evaluation.reason ?? 'UNKNOWN')}`,
      `🧮 حد مجاز: ${escapeHtml(formatPercentFa(evaluation.maxChangePercent) ?? '—')} در هر به‌روزرسانی`,
      `🕒 زمان: ${escapeHtml(tehranTimeFa(now))}`,
    ];

    if (suppressed > 0) {
      lines.push(
        `🔁 ${escapeHtml(String(suppressed))} هشدار مشابه در بازه اخیر ادغام شد`,
      );
    }

    lines.push(
      MESSAGE_DIVIDER,
      'ℹ️ این هشدار عملیاتی است و در کانال عمومی منتشر نمی‌شود.',
    );

    return lines.join('\n');
  }

  private displayUnitFor(evaluation: PriceEvaluation): 'RIAL' | 'TOMAN' {
    // USD-quoted instruments (XAUUSD) are reported in their own unit, so the amount is shown
    // without a Rial/Toman conversion.
    return evaluation.unit === 'USD' ? 'RIAL' : this.config.displayUnit;
  }
}
