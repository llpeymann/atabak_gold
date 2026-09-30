import {
  formatMoney,
  formatNumberFa,
  formatPercentFa,
  MoneyUnit,
} from '../common/money';
import { formatPriceValue } from '../market/price-format';
import { PriceUnit } from '../market/market.types';
import { SymbolDefinition } from '../market/symbols';
import { Alert, AlertDelivery, AlertStatus, AlertType } from './alert.types';

/**
 * Persian presentation of alerts (screens + notifications).
 *
 * Everything user-visible about an alert is produced here, from domain numbers only: values are
 * rendered through the central money/price formatters, and no unit conversion, rounding or
 * arbitration happens anywhere else (§30, §53). The formatter never decides *whether* an alert
 * may exist or fire — that is `AlertService`/`AlertEvaluator`.
 */

const STATUS_LABEL: Record<AlertStatus, string> = {
  ACTIVE: '🟢 فعال',
  DISABLED: '🔕 غیرفعال',
  TRIGGERED: '✅ فعال شده',
  DELETED: '🗑 حذف‌شده',
};

const TYPE_TITLE: Record<AlertType, string> = {
  PRICE_ABOVE: 'رسیدن به قیمت بالاتر یا برابر',
  PRICE_BELOW: 'افت به قیمت پایین‌تر یا برابر',
  PERCENT_INCREASE: 'افزایش درصدی',
  PERCENT_DECREASE: 'کاهش درصدی',
};

export interface AlertConditionParts {
  /** Canonical-unit value of the target (absolute alerts). */
  target: number | null;
  /** Positive magnitude (percentage alerts). */
  percent: number | null;
  direction: 'UP' | 'DOWN' | null;
  unit: PriceUnit;
}

/** One-line machine-independent description of the condition, e.g. `≥ ۱۷٬۵۰۰٬۰۰۰ ریال`. */
export function formatCondition(
  parts: AlertConditionParts,
  displayUnit: MoneyUnit,
): string {
  if (parts.percent !== null) {
    // `formatPercentFa` renders the sign itself: the direction decides the sign of the value.
    const signed =
      parts.direction === 'DOWN' ? -Math.abs(parts.percent) : parts.percent;

    return formatPercentFa(signed) ?? '—';
  }

  if (parts.target === null) {
    return '—';
  }

  const symbol = parts.direction === 'DOWN' ? '≤' : '≥';
  const value =
    parts.unit === 'USD'
      ? formatPriceValue(parts.target, 'USD', displayUnit)
      : formatMoney(parts.target, displayUnit);

  return `${symbol} ${value}`;
}

export function statusLabel(status: AlertStatus): string {
  return STATUS_LABEL[status];
}

export function typeTitle(type: AlertType): string {
  return TYPE_TITLE[type];
}

/** `🟡 طلای ۱۸ عیار` — registry label with its section emoji. */
export function symbolTitle(definition: SymbolDefinition): string {
  const emoji =
    definition.section === 'gold'
      ? '🟡'
      : definition.section === 'coins'
        ? '🪙'
        : '💵';

  return `${emoji} ${definition.label}`;
}

export function formatAlertLine(
  alert: Alert,
  definition: SymbolDefinition | null,
  displayUnit: MoneyUnit,
): string {
  const label = definition ? definition.label : alert.symbol;

  return (
    `${label}\n` +
    `${formatCondition(
      {
        target: alert.targetPrice,
        percent: alert.targetPercent,
        direction: alert.direction,
        unit: definition?.unit ?? 'RIAL',
      },
      displayUnit,
    )}\n` +
    `${statusLabel(alert.status)}`
  );
}

/** `🔔 هشدارهای من` list. */
export function formatAlertsListScreen(
  alerts: readonly Alert[],
  definitions: ReadonlyMap<string, SymbolDefinition>,
  displayUnit: MoneyUnit,
  limit: number,
): string {
  const lines = ['🔔 <b>هشدارهای من</b>', ''];

  if (alerts.length === 0) {
    lines.push(
      'هنوز هشداری نساخته‌اید.',
      '',
      'با «➕ ساخت هشدار» می‌توانید برای رسیدن قیمت به مقدار موردنظرتان هشدار بسازید.',
    );
    return lines.join('\n');
  }

  const numbers = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

  alerts.forEach((alert, index) => {
    const definition = definitions.get(alert.symbol) ?? null;
    const label = definition ? definition.label : alert.symbol;
    const marker = numbers[index] ?? `${index + 1}.`;

    lines.push(
      `${marker} ${label}`,
      formatCondition(
        {
          target: alert.targetPrice,
          percent: alert.targetPercent,
          direction: alert.direction,
          unit: definition?.unit ?? 'RIAL',
        },
        displayUnit,
      ),
      statusLabel(alert.status),
      '',
    );
  });

  lines.push(
    `📌 ${formatNumberFa(alerts.length)} از ${formatNumberFa(
      limit,
    )} سهمیهٔ هشدارهای فعال استفاده شده است.`,
  );

  return tidy(lines);
}

/** Confirmation screen before an alert is persisted (§31, §32). */
export function formatAlertConfirmation(input: {
  definition: SymbolDefinition;
  type: AlertType;
  target: number | null;
  percent: number | null;
  direction: 'UP' | 'DOWN' | null;
  baseline: number | null;
  /** Approximate target price of a percentage alert (presentation only). */
  approximateTarget: number | null;
  currentPrice: number | null;
  displayUnit: MoneyUnit;
  alreadyMet: boolean;
}): string {
  const { definition, displayUnit } = input;
  const lines = [
    '🔔 <b>تأیید هشدار</b>',
    '',
    `<b>نماد:</b> ${definition.label}`,
    '',
  ];

  lines.push(
    `<b>نوع:</b> ${typeTitle(input.type)}`,
    `<b>شرط:</b> ${formatCondition(
      {
        target: input.target,
        percent: input.percent,
        direction: input.direction,
        unit: definition.unit,
      },
      displayUnit,
    )}`,
  );

  if (input.currentPrice !== null) {
    lines.push(
      `<b>قیمت فعلی:</b> ${formatPriceValue(
        input.currentPrice,
        definition.unit,
        displayUnit,
      )}`,
    );
  } else {
    lines.push('<b>قیمت فعلی:</b> در دسترس نیست');
  }

  if (input.baseline !== null && input.percent !== null) {
    lines.push(
      `<b>قیمت مبنا:</b> ${formatPriceValue(
        input.baseline,
        definition.unit,
        displayUnit,
      )}`,
    );

    if (input.approximateTarget !== null) {
      lines.push(
        `<b>قیمت هدف تقریبی:</b> ${formatPriceValue(
          input.approximateTarget,
          definition.unit,
          displayUnit,
        )}`,
      );
    }
  }

  lines.push('<b>وضعیت:</b> 🟢 فعال', '');

  if (input.alreadyMet) {
    // §14: the condition is already true — never silently create it, ask for a decision.
    lines.push(
      '⚠️ شرط این هشدار همین حالا برقرار است.',
      'در صورت تأیید، هشدار ساخته می‌شود اما فقط با رسیدن قیمت پس از یک عبور تازه از مقدار هدف فعال خواهد شد.',
      '',
    );
  }

  lines.push('آیا هشدار ایجاد شود؟');

  return tidy(lines);
}

/** Alert detail screen (§40). */
export function formatAlertDetailScreen(
  alert: Alert,
  definition: SymbolDefinition | null,
  displayUnit: MoneyUnit,
  options: {
    triggeredTimeFa?: string | null;
    createdTimeFa?: string | null;
    deliveryNote?: string | null;
  },
): string {
  const lines = ['🔔 <b>جزئیات هشدار</b>', ''];

  lines.push(
    `<b>نماد:</b> ${definition ? definition.label : alert.symbol}`,
    `<b>نوع:</b> ${typeTitle(alert.type)}`,
    `<b>شرط:</b> ${formatCondition(
      {
        target: alert.targetPrice,
        percent: alert.targetPercent,
        direction: alert.direction,
        unit: definition?.unit ?? 'RIAL',
      },
      displayUnit,
    )}`,
  );

  if (alert.baselinePrice !== null) {
    lines.push(
      `<b>قیمت مبنا:</b> ${formatPriceValue(
        alert.baselinePrice,
        definition?.unit ?? 'RIAL',
        displayUnit,
      )}`,
    );
  }

  lines.push(`<b>وضعیت:</b> ${statusLabel(alert.status)}`);

  if (options.createdTimeFa) {
    lines.push(`<b>زمان ساخت:</b> ${options.createdTimeFa}`);
  }

  if (options.triggeredTimeFa) {
    lines.push(`<b>زمان فعال‌شدن:</b> ${options.triggeredTimeFa}`);
  }

  if (options.deliveryNote) {
    lines.push('', options.deliveryNote);
  }

  return tidy(lines);
}

export function formatAlertCreatedScreen(
  alert: Alert,
  definition: SymbolDefinition | null,
  displayUnit: MoneyUnit,
): string {
  return tidy([
    '✅ <b>هشدار با موفقیت ایجاد شد.</b>',
    '',
    `${definition ? definition.label : alert.symbol} — ${formatCondition(
      {
        target: alert.targetPrice,
        percent: alert.targetPercent,
        direction: alert.direction,
        unit: definition?.unit ?? 'RIAL',
      },
      displayUnit,
    )}`,
    '',
    'با رسیدن قیمت به این شرط (یک‌بار) به شما اطلاع می‌دهیم.',
  ]);
}

export function formatDeleteConfirmation(
  alert: Alert,
  definition: SymbolDefinition | null,
  displayUnit: MoneyUnit,
): string {
  return tidy([
    '🗑 <b>حذف هشدار</b>',
    '',
    `${definition ? definition.label : alert.symbol} — ${formatCondition(
      {
        target: alert.targetPrice,
        percent: alert.targetPercent,
        direction: alert.direction,
        unit: definition?.unit ?? 'RIAL',
      },
      displayUnit,
    )}`,
    '',
    'این هشدار حذف شود؟ این کار قابل بازگشت نیست.',
  ]);
}

/** Notification body delivered to the user when an alert fires (§48). Informational only. */
export function formatTriggerNotification(
  delivery: AlertDelivery,
  alert: Alert,
  definition: SymbolDefinition | null,
  displayUnit: MoneyUnit,
  timeFa: string | null,
): string {
  const unit = definition?.unit ?? 'RIAL';
  const label = definition?.label ?? alert.symbol;
  const current = formatPriceValue(delivery.triggerPrice, unit, displayUnit);

  const lines: string[] = [];

  if (alert.type === 'PERCENT_INCREASE' || alert.type === 'PERCENT_DECREASE') {
    lines.push(
      '🔔 <b>هشدار تغییر قیمت</b>',
      '',
      `${label} نسبت به قیمت مبنا ${
        formatPercentFa(
          alert.direction === 'DOWN'
            ? -Math.abs(alert.targetPercent ?? 0)
            : (alert.targetPercent ?? 0),
        ) ?? '—'
      } ${alert.direction === 'DOWN' ? 'کاهش' : 'افزایش'} پیدا کرد.`,
      '',
    );

    if (alert.baselinePrice !== null) {
      lines.push(
        `<b>قیمت مبنا:</b> ${formatPriceValue(
          alert.baselinePrice,
          unit,
          displayUnit,
        )}`,
      );
    }

    lines.push(
      `<b>قیمت فعلی:</b> ${current}`,
      `<b>تغییر:</b> ${formatPercentFa(delivery.triggerPercent ?? 0) ?? '—'}`,
    );
  } else {
    lines.push(
      '🔔 <b>هشدار قیمت</b>',
      '',
      `${label} به قیمت موردنظر شما رسید.`,
      '',
      `<b>قیمت فعلی:</b> ${current}`,
      `<b>شرط:</b> ${formatCondition(
        {
          target: alert.targetPrice,
          percent: null,
          direction: alert.type === 'PRICE_BELOW' ? 'DOWN' : 'UP',
          unit,
        },
        displayUnit,
      )}`,
    );
  }

  if (timeFa) {
    lines.push('', `⏰ <b>زمان:</b> ${timeFa}`);
  }

  lines.push('', 'ℹ️ این هشدار یک‌بار اجرا شد و غیرفعال شده است.');

  return tidy(lines);
}

/** Entry screen of `🔔 هشدار` (§23): the hub, not a placeholder anymore. */
export function formatAlertsHub(): string {
  return tidy([
    '🔔 <b>هشدار قیمت</b>',
    '',
    'با ساخت هشدار، وقتی قیمت یک نماد به مقدار موردنظر شما برسد یک‌بار به شما اطلاع می‌دهیم.',
    '',
    '➕ ساخت هشدار — ساخت هشدار تازه',
    '🔔 هشدارهای من — دیدن و مدیریت هشدارها',
    '',
    'ℹ️ هر هشدار یک‌بار اجرا می‌شود و پس از آن غیرفعال است.',
  ]);
}

/** Prompt shown while a wizard waits for a numeric answer. */
export function formatInvalidTargetRetry(prompt: string): string {
  return `${ALERT_TEXTS.invalidTarget}\n\n${prompt}`;
}

/** Empty/blocked states of the alert screens. */
export const ALERT_TEXTS = {
  notFound: '⚠️ این هشدار دیگر قابل استفاده نیست.',
  invalidTarget: '⚠️ مقدار واردشده معتبر نیست.',
  unknownSymbol: '⚠️ این نماد پشتیبانی نمی‌شود.',
  noValidPrice: '⚠️ قیمت معتبر این نماد در دسترس نیست.',
  duplicate: '⚠️ این هشدار از قبل وجود دارد.',
  invalidState: '⚠️ این کار در وضعیت فعلی این هشدار امکان‌پذیر نیست.',
} as const;

export function formatAlertLimitReached(limit: number): string {
  return (
    '⚠️ به حداکثر تعداد هشدار مجاز رسیده‌اید.\n\n' +
    `سقف مجاز: ${formatNumberFa(limit)}\n` +
    'برای ایجاد هشدار جدید، ابتدا یکی از هشدارهای فعلی را حذف کنید.\n' +
    'توجه: هشدارهای غیرفعال هم بخشی از سهمیه هستند؛ فقط حذف، سهمیه را آزاد می‌کند.'
  );
}

export function formatSymbolPrompt(): string {
  return tidy([
    '🔔 <b>ساخت هشدار</b>',
    '',
    'نمادی را که می‌خواهید برای آن هشدار بسازید انتخاب کنید:',
  ]);
}

export function formatTypePrompt(definition: SymbolDefinition | null): string {
  return tidy([
    '🔔 <b>ساخت هشدار</b>',
    '',
    definition ? `<b>نماد:</b> ${definition.label}` : '',
    '',
    'نوع هشدار را انتخاب کنید:',
  ]);
}

export function formatTargetPrompt(
  definition: SymbolDefinition,
  type: AlertType,
  displayUnit: MoneyUnit,
): string {
  if (type === 'PERCENT_INCREASE' || type === 'PERCENT_DECREASE') {
    return tidy([
      '🔔 <b>ساخت هشدار</b>',
      '',
      `<b>نماد:</b> ${definition.label}`,
      `<b>نوع:</b> ${typeTitle(type)}`,
      '',
      'درصد تغییر را وارد کنید (مثال: ۲)',
    ]);
  }

  const direction = type === 'PRICE_ABOVE' ? 'بالاتر' : 'پایین‌تر';
  // A realistic example: twice the registry's lower bound (the bounds are guardrails).
  const lowerBound = definition.minPrice ?? 0;
  const example = formatPriceValue(
    lowerBound * 2,
    definition.unit,
    displayUnit,
  );

  return tidy([
    '🔔 <b>ساخت هشدار</b>',
    '',
    `<b>نماد:</b> ${definition.label}`,
    `<b>نوع:</b> رسیدن به قیمت ${direction}`,
    '',
    'قیمت هدف را وارد کنید.',
    `(واحد: ${definition.unit === 'USD' ? 'دلار' : 'ریال/تومان'})`,
    '',
    `مثال: ${example}`,
  ]);
}

export function formatEditPrompt(
  alert: Alert,
  definition: SymbolDefinition | null,
  displayUnit: MoneyUnit,
): string {
  const label = definition ? definition.label : alert.symbol;

  return tidy([
    '✏️ <b>ویرایش هشدار</b>',
    '',
    `<b>نماد:</b> ${label}`,
    `<b>مقدار فعلی:</b> ${formatCondition(
      {
        target: alert.targetPrice,
        percent: alert.targetPercent,
        direction: alert.direction,
        unit: definition?.unit ?? 'RIAL',
      },
      displayUnit,
    )}`,
    '',
    alert.type === 'PERCENT_INCREASE' || alert.type === 'PERCENT_DECREASE'
      ? 'درصد جدید را وارد کنید (مثال: ۲)'
      : 'قیمت هدف جدید را وارد کنید.',
    '',
    'برای انصراف، «⬅️ بازگشت» را بزنید.',
  ]);
}

export function formatAlertWizardCancelled(): string {
  return tidy([
    'ساخت هشدار لغو شد.',
    '',
    'می‌توانید از منوی هشدار دوباره شروع کنید.',
  ]);
}

function tidy(lines: readonly string[]): string {
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
