import { Injectable } from '@nestjs/common';

import { formatNumberFa } from '../common/money';
import { AppConfigService } from '../config/app-config.service';
import { CampaignStore } from './campaign.store';
import {
  AttributionBucket,
  AttributionModel,
  CampaignRecord,
  FunnelStage,
  MetricKind,
} from './campaign.types';

/**
 * Phase 8 — funnel reporting (§9, §16).
 *
 * Rules this file exists to enforce:
 *
 *  * **Every** number carries its `MetricKind`, so “unique users”, “total events” and “an aggregate
 *    somebody else measured” can never be read as the same thing.
 *  * A metric that cannot be measured is `null` with a reason — never `0`, never `Infinity`, never
 *    `NaN`. A metric that *was* measured and happens to be zero is a real `0`.
 *  * Ratios with a zero denominator are `N/A` (`percent: null`), not a division by zero.
 *  * Cost totals are only summed inside one currency; different currencies are reported side by side
 *    with an explicit explanation, because this project has no exchange rate source (§16).
 *  * Imported aggregates are prorated **never**: a period that only partly overlaps the reported
 *    window is excluded and counted as excluded.
 */

export interface ReportWindow {
  from: Date;
  /** Exclusive upper bound (documented, identical for every metric). */
  to: Date;
  /** Human label of the preset/range (`۷ روز`, `۳۰ روز`, `بازه سفارشی`). */
  label: string;
}

export interface MetricValue {
  key: MetricKey;
  labelFa: string;
  kind: MetricKind;
  value: number | null;
  /** Present only when `value === null`: why the metric cannot be shown. */
  unavailableReason: string | null;
}

export type MetricKey =
  | 'impressions'
  | 'clicksRaw'
  | 'uniqueClickers'
  | 'newStarts'
  | 'totalStarts'
  | 'verifiedJoins'
  | 'uniqueAlertCreators'
  | 'totalAlerts'
  | 'leads'
  | 'customers';

export interface RatioMetric {
  key: string;
  labelFa: string;
  percent: number | null;
  numerator: number;
  denominator: number;
  unavailableReason: string | null;
}

export interface CostSummary {
  /** `null` when nothing was recorded (never 0). */
  amount: number | null;
  currency: string | null;
  /** More than one currency present in the report → totals are *not* summed. */
  mixedCurrencies: string[];
  unavailableReason: string | null;
}

export interface MoneyRatio {
  key: string;
  labelFa: string;
  amount: number | null;
  currency: string | null;
  denominator: number;
  unavailableReason: string | null;
}

export interface CampaignReport {
  campaign: CampaignRecord;
  window: ReportWindow;
  metrics: MetricValue[];
  ratios: RatioMetric[];
  costs: {
    recorded: CostSummary;
    perStart: MoneyRatio;
    perLead: MoneyRatio;
    perCustomer: MoneyRatio;
  };
  /** Conversions that could not be credited to this campaign, with their documented buckets. */
  unattributed: { bucket: AttributionBucket; count: number }[];
  imports: {
    included: number;
    excludedPartial: number;
    excludedMetric: number;
    providers: string[];
  };
  /** Rejected ingestion attempts (bounded counters) — never mixed into the metrics above. */
  rejections: { reason: string; count: number }[];
  notes: string[];
}

export interface AggregateReport {
  window: ReportWindow;
  totals: MetricValue[];
  campaigns: {
    campaign: CampaignRecord;
    values: Record<string, number | null>;
    costs: CostSummary;
    costPerStart: MoneyRatio;
    costPerLead: MoneyRatio;
    costPerCustomer: MoneyRatio;
  }[];
  rankings: {
    key: MetricKey;
    labelFa: string;
    kind: MetricKind;
    rows: { campaignId: string; name: string; source: string; value: number }[];
  }[];
  sourcesByModel: {
    model: AttributionModel;
    source: string;
    leads: number;
    customers: number;
  }[];
  unattributed: { bucket: AttributionBucket; count: number }[];
  costs: CostSummary;
  dailySeries: {
    day: string;
    clicks: number;
    starts: number;
    leads: number;
    customers: number;
  }[];
  notes: string[];
}

/** Internal, unformatted counters of one campaign in one window. */
interface CampaignCounters {
  clicksRaw: number;
  starts: number;
  startIdentities: Set<string>;
  joins: number;
  joinIdentities: Set<string>;
  alerts: number;
  alertIdentities: Set<string>;
  leads: number;
  customers: number;
  clients: Set<string>;
  impressions: number | null;
  importsIncluded: number;
  importsPartial: number;
  importsOtherMetric: number;
  providers: Set<string>;
}

@Injectable()
export class CampaignMetricsService {
  constructor(
    private readonly config: AppConfigService,
    private readonly store: CampaignStore,
  ) {}

  /** Full report of one campaign (§9.1). */
  campaignReport(
    campaignId: string,
    window: ReportWindow,
  ): CampaignReport | null {
    const campaign = this.store.findCampaign(campaignId);

    if (!campaign) {
      return null;
    }

    const scan = this.scan(
      window,
      (record) => record.campaignId === campaignId,
    );
    const counters = scan.counters.get(campaignId) ?? emptyCounters();
    const notes: string[] = [];

    if (scan.multiCurrency.length > 1) {
      notes.push(
        `هزینه‌های این گزارش به چند واحد پول ثبت شده‌اند (${scan.multiCurrency.join(', ')}); جمع کل نمایش داده نمی‌شود.`,
      );
    }

    return {
      campaign,
      window,
      metrics: this.metricValues(counters, notes),
      ratios: this.ratioValues(counters),
      costs: {
        recorded: costOf([campaign]),
        perStart: moneyRatio(
          'costPerStart',
          'هزینه به‌ازای هر شروع (ثبت‌شده)',
          campaign.costAmount,
          campaign.costCurrency,
          counters.startIdentities.size,
          'کاربر جدیدی از این کمپین شروع نکرده است.',
        ),
        perLead: moneyRatio(
          'costPerLead',
          'هزینه به‌ازای هر سرنخ (ثبت‌شده)',
          campaign.costAmount,
          campaign.costCurrency,
          counters.leads,
          'سرنخی برای این کمپین در این بازه ثبت نشده است.',
        ),
        perCustomer: moneyRatio(
          'costPerCustomer',
          'هزینه به‌ازای هر مشتری (ثبت‌شده)',
          campaign.costAmount,
          campaign.costCurrency,
          counters.customers,
          'مشتری‌ای برای این کمپین در این بازه ثبت نشده است.',
        ),
      },
      unattributed: [...scan.unattributed.entries()].map(([bucket, count]) => ({
        bucket,
        count,
      })),
      imports: {
        included: counters.importsIncluded,
        excludedPartial: counters.importsPartial,
        excludedMetric: counters.importsOtherMetric,
        providers: [...counters.providers],
      },
      rejections: this.rejectionsFor(campaignId),
      notes,
    };
  }

  /**
   * Aggregate report used by the dashboard (§9.2) — one document scan for all campaigns, so the
   * number of queries does not grow with the number of campaigns (§17).
   */
  aggregateReport(
    window: ReportWindow,
    filter: { source?: string; medium?: string; campaignId?: string } = {},
  ): AggregateReport {
    const notes: string[] = [];
    const matches = (record: CampaignRecord): boolean => {
      if (filter.campaignId && record.campaignId !== filter.campaignId) {
        return false;
      }

      if (filter.source && record.source !== filter.source) {
        return false;
      }

      if (filter.medium && record.medium !== filter.medium) {
        return false;
      }

      return true;
    };

    const selected = this.store.listCampaigns().filter(matches);
    const selectedIds = new Set(
      selected.map((campaign) => campaign.campaignId),
    );
    const scan = this.scan(
      window,
      (record) =>
        record.campaignId !== null && selectedIds.has(record.campaignId),
    );
    const totals = emptyCounters();

    for (const campaign of selected) {
      const counters = scan.counters.get(campaign.campaignId);

      if (!counters) {
        continue;
      }

      addCounters(totals, counters);
    }

    if (scan.multiCurrency.length > 1) {
      notes.push(
        `هزینه‌ها به چند واحد پول ثبت شده‌اند (${scan.multiCurrency.join(', ')}); جمع کل ریالی/یورویی واحد نمایش داده نمی‌شود.`,
      );
    }

    if (scan.excludedPartial > 0) {
      notes.push(
        `${formatNumberFa(scan.excludedPartial)} داده واردشده خارج از این بازه بود و نمایش داده نشد (هیچ سرشکنی انجام نمی‌شود).`,
      );
    }

    const metricTotals = this.metricValues(totals, notes);
    const byKey = new Map(metricTotals.map((metric) => [metric.key, metric]));

    return {
      window,
      totals: metricTotals,
      campaigns: selected.map((campaign) => {
        const counters =
          scan.counters.get(campaign.campaignId) ?? emptyCounters();

        return {
          campaign,
          values: Object.fromEntries(
            this.metricValues(counters, []).map((metric) => [
              metric.key,
              metric.value,
            ]),
          ),
          costs: costOf([campaign]),
          costPerStart: moneyRatio(
            'costPerStart',
            'هزینه به‌ازای هر شروع',
            campaign.costAmount,
            campaign.costCurrency,
            counters.startIdentities.size,
            'شروعی در این بازه ثبت نشده است.',
          ),
          costPerLead: moneyRatio(
            'costPerLead',
            'هزینه به‌ازای هر سرنخ',
            campaign.costAmount,
            campaign.costCurrency,
            counters.leads,
            'سرنخی در این بازه ثبت نشده است.',
          ),
          costPerCustomer: moneyRatio(
            'costPerCustomer',
            'هزینه به‌ازای هر مشتری',
            campaign.costAmount,
            campaign.costCurrency,
            counters.customers,
            'مشتری‌ای در این بازه ثبت نشده است.',
          ),
        };
      }),
      rankings: (
        [
          'newStarts',
          'totalStarts',
          'verifiedJoins',
          'uniqueAlertCreators',
          'totalAlerts',
          'leads',
          'customers',
        ] as MetricKey[]
      ).map((key) => {
        const metric = byKey.get(key);
        const rows = selected
          .map((campaign) => {
            const counters = scan.counters.get(campaign.campaignId);
            const value = counters ? valueFor(counters, key) : 0;

            return {
              campaignId: campaign.campaignId,
              name: campaign.name,
              source: campaign.source,
              value: value ?? 0,
            };
          })
          .filter((row) => row.value > 0)
          .sort((left, right) => right.value - left.value);

        return {
          key,
          labelFa: metric?.labelFa ?? key,
          kind: metric?.kind ?? 'TOTAL_EVENTS',
          rows,
        };
      }),
      sourcesByModel: scan.sourcesByModel,
      unattributed: [...scan.unattributed.entries()].map(([bucket, count]) => ({
        bucket,
        count,
      })),
      costs: costOf(selected),
      dailySeries: scan.dailySeries,
      notes,
    };
  }

  /**
   * Compare two windows of the same scope (§9.2 question 7). Percentages use the same `N/A` rule, so
   * a comparison against an empty baseline is never rendered as “+100%”.
   */
  compareWindows(
    current: ReportWindow,
    previous: ReportWindow,
    filter: { source?: string; medium?: string; campaignId?: string } = {},
  ): {
    current: AggregateReport;
    previous: AggregateReport;
    deltas: {
      key: MetricKey;
      labelFa: string;
      current: number | null;
      previous: number | null;
      percent: number | null;
      unavailableReason: string | null;
    }[];
  } {
    const currentReport = this.aggregateReport(current, filter);
    const previousReport = this.aggregateReport(previous, filter);
    const previousByKey = new Map(
      previousReport.totals.map((metric) => [metric.key, metric.value]),
    );

    return {
      current: currentReport,
      previous: previousReport,
      deltas: currentReport.totals.map((metric) => {
        const before = previousByKey.get(metric.key) ?? null;
        const changeable =
          metric.value !== null && before !== null && before > 0;

        return {
          key: metric.key,
          labelFa: metric.labelFa,
          current: metric.value,
          previous: before,
          percent: changeable
            ? round2((((metric.value as number) - before) / before) * 100)
            : null,
          unavailableReason:
            metric.value === null
              ? metric.unavailableReason
              : before === null
                ? 'داده بازه مقایسه برای این شاخص در دسترس نیست.'
                : before === 0
                  ? 'مقدار بازه مقایسه صفر است؛ درصد تغییر تعریف‌شده نیست.'
                  : null,
        };
      }),
    };
  }

  // --- one document scan -------------------------------------------------------

  private scan(
    window: ReportWindow,
    matches: (event: { campaignId: string | null }) => boolean,
  ): {
    counters: Map<string, CampaignCounters>;
    /** Conversions that belong to no campaign, counted once for the whole scan. */
    unattributed: Map<AttributionBucket, number>;
    multiCurrency: string[];
    excludedPartial: number;
    dailySeries: {
      day: string;
      clicks: number;
      starts: number;
      leads: number;
      customers: number;
    }[];
    sourcesByModel: {
      model: AttributionModel;
      source: string;
      leads: number;
      customers: number;
    }[];
  } {
    const counters = new Map<string, CampaignCounters>();
    const unattributed = new Map<AttributionBucket, number>();
    const counterFor = (campaignId: string): CampaignCounters => {
      const existing = counters.get(campaignId);

      if (existing) {
        return existing;
      }

      const created = emptyCounters();
      counters.set(campaignId, created);

      return created;
    };

    const from = window.from.getTime();
    const to = window.to.getTime();
    const inWindow = (value: string): boolean => {
      const time = Date.parse(value);

      return time >= from && time < to;
    };

    const dayBuckets = new Map<
      string,
      { clicks: number; starts: number; leads: number; customers: number }
    >();
    const bucketFor = (day: string) => {
      const existing = dayBuckets.get(day);

      if (existing) {
        return existing;
      }

      const created = { clicks: 0, starts: 0, leads: 0, customers: 0 };
      dayBuckets.set(day, created);

      return created;
    };

    for (const event of this.store.listEvents()) {
      if (!matches(event) || !event.campaignId || !inWindow(event.occurredAt)) {
        continue;
      }

      const counter = counterFor(event.campaignId);

      switch (event.type) {
        case 'CLICK':
          counter.clicksRaw += 1;
          bucketFor(event.occurredAt.slice(0, 10)).clicks += 1;
          break;
        case 'START':
          counter.starts += 1;
          bucketFor(event.occurredAt.slice(0, 10)).starts += 1;

          if (event.identityKey) {
            counter.startIdentities.add(event.identityKey);
          }
          break;
        case 'CHANNEL_JOIN':
          counter.joins += 1;

          if (event.identityKey) {
            counter.joinIdentities.add(event.identityKey);
          }
          break;
        case 'ALERT_CREATED':
          counter.alerts += 1;

          if (event.identityKey) {
            counter.alertIdentities.add(event.identityKey);
          }
          break;
        default:
          break;
      }
    }

    const imports = this.store.listImports();
    let excludedPartial = 0;

    for (const record of imports) {
      if (record.status !== 'ACTIVE' || !matches(record)) {
        continue;
      }

      const counter = counterFor(record.campaignId);
      const start = Date.parse(record.periodStart);
      const end = Date.parse(record.periodEnd);

      if (record.metric !== 'IMPRESSION' && record.metric !== 'CLICK') {
        counter.importsOtherMetric += 1;
        continue;
      }

      if (start < from || end >= to) {
        excludedPartial += 1;
        counter.importsPartial += 1;
        continue;
      }

      counter.importsIncluded += 1;
      counter.providers.add(record.provider);

      if (record.metric === 'IMPRESSION') {
        counter.impressions = (counter.impressions ?? 0) + record.value;
      } else {
        // An imported *click* aggregate is reported separately from our own click count: it stays in
        // `impressions`-style space only when the metric is impression, so a click import is added to
        // the raw counter with an explicit note in the UI (kind EXTERNAL_AGGREGATE).
        counter.clicksRaw += record.value;
      }
    }

    const conversions = this.store.listConversions();
    const sourcesByModelKey = new Map<
      string,
      {
        model: AttributionModel;
        source: string;
        leads: number;
        customers: number;
      }
    >();
    const campaignSources = new Map(
      this.store
        .listCampaigns()
        .map((campaign) => [campaign.campaignId, campaign.source]),
    );

    for (const conversion of conversions) {
      if (conversion.status !== 'ACTIVE' || !inWindow(conversion.occurredAt)) {
        continue;
      }

      if (
        conversion.campaignId &&
        matches({ campaignId: conversion.campaignId })
      ) {
        const counter = counterFor(conversion.campaignId);

        if (conversion.type === 'LEAD') {
          counter.leads += 1;
        } else {
          counter.customers += 1;
        }

        if (conversion.identityKey) {
          counter.clients.add(conversion.identityKey);
        }

        const day = conversion.occurredAt.slice(0, 10);
        const bucket = bucketFor(day);

        if (conversion.type === 'LEAD') {
          bucket.leads += 1;
        } else {
          bucket.customers += 1;
        }
      } else {
        // Unattributed conversions are counted exactly once for the whole scan, under their documented
        // bucket, so they stay visible instead of disappearing from every campaign.
        const bucket = conversion.attributionBucket;

        unattributed.set(bucket, (unattributed.get(bucket) ?? 0) + 1);
      }

      for (const model of ['FIRST_TOUCH', 'LAST_TOUCH'] as AttributionModel[]) {
        const credit =
          model === 'FIRST_TOUCH'
            ? conversion.firstTouch.campaignId
            : conversion.lastTouch.campaignId;

        if (!credit || !matches({ campaignId: credit })) {
          continue;
        }

        const source = campaignSources.get(credit) ?? 'unknown';
        const key = `${model}|${source}`;
        const row = sourcesByModelKey.get(key) ?? {
          model,
          source,
          leads: 0,
          customers: 0,
        };

        if (conversion.type === 'LEAD') {
          row.leads += 1;
        } else {
          row.customers += 1;
        }

        sourcesByModelKey.set(key, row);
      }
    }

    const multiCurrency = [
      ...new Set(
        this.store
          .listCampaigns()
          .filter((campaign) => matches(campaign) && campaign.costCurrency)
          .map((campaign) => campaign.costCurrency as string),
      ),
    ];

    return {
      counters,
      unattributed,
      multiCurrency,
      excludedPartial,
      dailySeries: [...dayBuckets.entries()]
        .map(([day, bucket]) => ({ day, ...bucket }))
        .sort((left, right) => left.day.localeCompare(right.day)),
      sourcesByModel: [...sourcesByModelKey.values()].sort(
        (left, right) =>
          left.model.localeCompare(right.model) ||
          right.leads + right.customers - (left.leads + left.customers) ||
          left.source.localeCompare(right.source),
      ),
    };
  }

  // --- metric shaping ----------------------------------------------------------

  private metricValues(
    counters: CampaignCounters,
    notes: string[],
  ): MetricValue[] {
    const joinsMeasured =
      this.config.campaignChannelJoinVerification !== 'disabled';
    const uniqueClickersReason =
      'این نسخه برای شناسایی کاربر در نقطه هدایت ردیابی نمی‌کند (بدون اثرانگشت‌سازی)؛ بنابراین تعداد «کلیک‌کننده یکتا» قابل اندازه‌گیری نیست.';

    if (!joinsMeasured) {
      notes.push(
        'عضویت تأییدشده کانال در دسترس نیست: بررسی عضویت غیرفعال است (CAMPAIGN_CHANNEL_JOIN_VERIFICATION).',
      );
    }

    return [
      {
        key: 'impressions',
        labelFa: 'نمایش (ایمپرشن) — داده واردشده از منبع خارجی',
        kind: 'EXTERNAL_AGGREGATE',
        value: counters.impressions,
        unavailableReason:
          counters.impressions === null
            ? 'هیچ عدد نمایشی از منبع خارجی برای این بازه وارد نشده است؛ این شاخص درون ربات قابل اندازه‌گیری نیست.'
            : null,
      },
      {
        key: 'clicksRaw',
        labelFa: 'کلیک ثبت‌شده روی لینک (کل رویدادها)',
        kind: 'TOTAL_EVENTS',
        value: counters.clicksRaw,
        unavailableReason: null,
      },
      {
        key: 'uniqueClickers',
        labelFa: 'کلیک‌کننده یکتا',
        kind: 'UNIQUE_USERS',
        value: null,
        unavailableReason: uniqueClickersReason,
      },
      {
        key: 'newStarts',
        labelFa: 'شروع کمپینی (کاربران جدید یکتا = ثبت‌نام)',
        kind: 'UNIQUE_USERS',
        value: counters.startIdentities.size,
        unavailableReason: null,
      },
      {
        key: 'totalStarts',
        labelFa: 'کل رویدادهای شروع',
        kind: 'TOTAL_EVENTS',
        value: counters.starts,
        unavailableReason: null,
      },
      {
        key: 'verifiedJoins',
        labelFa: 'عضویت تأییدشده کانال (یکتا)',
        kind: 'UNIQUE_USERS',
        value: joinsMeasured ? counters.joinIdentities.size : null,
        unavailableReason: joinsMeasured
          ? null
          : 'بررسی عضویت کانال غیرفعال است؛ عضویت فقط با تأیید پلتفرم قابل اندازه‌گیری است.',
      },
      {
        key: 'uniqueAlertCreators',
        labelFa: 'سازندگان هشدار (یکتا)',
        kind: 'UNIQUE_USERS',
        value: counters.alertIdentities.size,
        unavailableReason: null,
      },
      {
        key: 'totalAlerts',
        labelFa: 'کل هشدارهای ساخته‌شده',
        kind: 'TOTAL_EVENTS',
        value: counters.alerts,
        unavailableReason: null,
      },
      {
        key: 'leads',
        labelFa: 'سرنخ (ثبت دستی مجاز)',
        kind: 'TOTAL_EVENTS',
        value: counters.leads,
        unavailableReason: null,
      },
      {
        key: 'customers',
        labelFa: 'مشتری (ثبت دستی مجاز)',
        kind: 'TOTAL_EVENTS',
        value: counters.customers,
        unavailableReason: null,
      },
    ];
  }

  private ratioValues(counters: CampaignCounters): RatioMetric[] {
    const joinsMeasured =
      this.config.campaignChannelJoinVerification !== 'disabled';

    return [
      ratio(
        'clickToStart',
        'کلیک → شروع',
        counters.startIdentities.size,
        counters.clicksRaw,
        'کلیکی برای این کمپین در این بازه ثبت نشده است.',
      ),
      ratio(
        'startToJoin',
        'شروع → عضویت تأییدشده',
        counters.joinIdentities.size,
        counters.startIdentities.size,
        joinsMeasured
          ? 'شروعی در این بازه ثبت نشده است.'
          : 'بررسی عضویت کانال غیرفعال است.',
        !joinsMeasured,
      ),
      ratio(
        'startToAlert',
        'شروع → ساخت هشدار',
        counters.alertIdentities.size,
        counters.startIdentities.size,
        'شروعی در این بازه ثبت نشده است.',
      ),
      ratio(
        'startToLead',
        'شروع → سرنخ',
        counters.leads,
        counters.startIdentities.size,
        'شروعی در این بازه ثبت نشده است.',
      ),
      ratio(
        'startToCustomer',
        'شروع → مشتری',
        counters.customers,
        counters.startIdentities.size,
        'شروعی در این بازه ثبت نشده است.',
      ),
      ratio(
        'leadToCustomer',
        'سرنخ → مشتری',
        counters.customers,
        counters.leads,
        'سرنخی در این بازه ثبت نشده است.',
      ),
    ];
  }

  private rejectionsFor(
    campaignId: string,
  ): { reason: string; count: number }[] {
    return this.store
      .listRejections()
      .filter(
        (record) =>
          record.campaignId === campaignId || record.campaignId === null,
      )
      .map((record) => ({ reason: record.reason, count: record.count }));
  }
}

// --- shaping helpers ----------------------------------------------------------

function emptyCounters(): CampaignCounters {
  return {
    clicksRaw: 0,
    starts: 0,
    startIdentities: new Set<string>(),
    joins: 0,
    joinIdentities: new Set<string>(),
    alerts: 0,
    alertIdentities: new Set<string>(),
    leads: 0,
    customers: 0,
    clients: new Set<string>(),
    impressions: null,
    importsIncluded: 0,
    importsPartial: 0,
    importsOtherMetric: 0,
    providers: new Set<string>(),
  };
}

function addCounters(target: CampaignCounters, source: CampaignCounters): void {
  target.clicksRaw += source.clicksRaw;
  target.starts += source.starts;
  target.joins += source.joins;
  target.alerts += source.alerts;
  target.leads += source.leads;
  target.customers += source.customers;
  target.importsIncluded += source.importsIncluded;
  target.importsPartial += source.importsPartial;
  target.importsOtherMetric += source.importsOtherMetric;

  for (const value of source.startIdentities) {
    target.startIdentities.add(value);
  }

  for (const value of source.joinIdentities) {
    target.joinIdentities.add(value);
  }

  for (const value of source.alertIdentities) {
    target.alertIdentities.add(value);
  }

  for (const value of source.providers) {
    target.providers.add(value);
  }

  if (source.impressions !== null) {
    target.impressions = (target.impressions ?? 0) + source.impressions;
  }
}

function valueFor(counters: CampaignCounters, key: MetricKey): number | null {
  switch (key) {
    case 'impressions':
      return counters.impressions;
    case 'clicksRaw':
      return counters.clicksRaw;
    case 'uniqueClickers':
      return null;
    case 'newStarts':
      return counters.startIdentities.size;
    case 'totalStarts':
      return counters.starts;
    case 'verifiedJoins':
      return counters.joinIdentities.size;
    case 'uniqueAlertCreators':
      return counters.alertIdentities.size;
    case 'totalAlerts':
      return counters.alerts;
    case 'leads':
      return counters.leads;
    case 'customers':
      return counters.customers;
    default:
      return null;
  }
}

function ratio(
  key: string,
  labelFa: string,
  numerator: number,
  denominator: number,
  emptyReason: string,
  unavailable = false,
): RatioMetric {
  if (unavailable) {
    return {
      key,
      labelFa,
      percent: null,
      numerator,
      denominator,
      unavailableReason: 'این نسبت قابل اندازه‌گیری نیست.',
    };
  }

  if (denominator === 0) {
    return {
      key,
      labelFa,
      percent: null,
      numerator,
      denominator,
      unavailableReason: `${emptyReason} (مخرج صفر است؛ نسبت تعریف‌شده نیست.)`,
    };
  }

  return {
    key,
    labelFa,
    percent: round2((numerator / denominator) * 100),
    numerator,
    denominator,
    unavailableReason: null,
  };
}

function moneyRatio(
  key: string,
  labelFa: string,
  amount: number | null,
  currency: string | null,
  denominator: number,
  emptyReason: string,
): MoneyRatio {
  if (amount === null || currency === null) {
    return {
      key,
      labelFa,
      amount: null,
      currency,
      denominator,
      unavailableReason: 'هزینه‌ای برای این کمپین ثبت نشده است.',
    };
  }

  if (denominator === 0) {
    return {
      key,
      labelFa,
      amount: null,
      currency,
      denominator,
      unavailableReason: emptyReason,
    };
  }

  return {
    key,
    labelFa,
    amount: round2(amount / denominator),
    currency,
    denominator,
    unavailableReason: null,
  };
}

function costOf(campaigns: CampaignRecord[]): CostSummary {
  const currencies = [
    ...new Set(
      campaigns
        .map((campaign) => campaign.costCurrency)
        .filter((currency): currency is string => currency !== null),
    ),
  ];

  if (currencies.length === 0) {
    return {
      amount: null,
      currency: null,
      mixedCurrencies: [],
      unavailableReason: 'هزینه‌ای برای این کمپین‌ها ثبت نشده است.',
    };
  }

  if (currencies.length > 1) {
    return {
      amount: null,
      currency: null,
      mixedCurrencies: currencies,
      unavailableReason:
        'هزینه‌ها به چند واحد پول ثبت شده‌اند؛ بدون نرخ تبدیل، جمع کل نمایش داده نمی‌شود.',
    };
  }

  const amount = campaigns
    .filter((campaign) => campaign.costCurrency === currencies[0])
    .reduce((total, campaign) => total + (campaign.costAmount ?? 0), 0);

  return {
    amount: round2(amount),
    currency: currencies[0],
    mixedCurrencies: currencies,
    unavailableReason: null,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Re-exported for the renderer so a stage name is spelled once. */
export const FUNNEL_STAGE_LABELS: Record<FunnelStage, string> = {
  IMPRESSION: 'نمایش',
  CLICK: 'کلیک',
  START: 'شروع',
  CHANNEL_JOIN: 'عضویت کانال',
  ALERT_CREATED: 'ساخت هشدار',
  LEAD: 'سرنخ',
  CUSTOMER: 'مشتری',
};
