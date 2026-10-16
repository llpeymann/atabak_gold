/**
 * Phase 10 — keyboards of the administrative surface.
 *
 * Every button here is a *request*: `callback-data.ts` validates its payload and the admin service
 * re-authorizes the press server-side, so a keyboard can never be the thing that grants access
 * (§12.3 “hiding a button is not authorization”).
 *
 * Layout rules:
 *
 *  * no destructive action is reachable in one press — publishing changes, test messages, alert
 *    enable/disable and starting a broadcast all go through an explicit confirmation row;
 *  * every list screen has a refresh, a back and a pagination row when it is longer than one page;
 *  * a button is only rendered when its target is a real, working screen (no dead entries, §3).
 */

import { Keyboard } from '../../platform/platform.types';
import {
  AdminAlertFilterToken,
  AdminAudienceToken,
  AdminIncidentFilterToken,
  AdminLeadFilterToken,
  AdminUserFilterToken,
  callbackDataForAdminAlert,
  callbackDataForAdminAlertState,
  callbackDataForAdminAlerts,
  callbackDataForAdminAudit,
  callbackDataForAdminBroadcast,
  callbackDataForAdminBroadcastAudience,
  callbackDataForAdminBroadcastCancel,
  callbackDataForAdminBroadcastList,
  callbackDataForAdminBroadcastPreview,
  callbackDataForAdminBroadcastReport,
  callbackDataForAdminBroadcastRetry,
  callbackDataForAdminBroadcastSave,
  callbackDataForAdminBroadcastStart,
  callbackDataForAdminBroadcastText,
  callbackDataForAdminCampaignFunnel,
  callbackDataForAdminCampaigns,
  callbackDataForAdminChannelHistory,
  callbackDataForAdminChannels,
  callbackDataForAdminDictionary,
  callbackDataForAdminError,
  callbackDataForAdminErrorAct,
  callbackDataForAdminErrorRetry,
  callbackDataForAdminErrors,
  callbackDataForAdminHub,
  callbackDataForAdminLeads,
  callbackDataForAdminPublishing,
  callbackDataForAdminStats,
  callbackDataForAdminStatsCustom,
  callbackDataForAdminTestMessage,
  callbackDataForAdminUser,
  callbackDataForAdminUserSearch,
  callbackDataForAdminUsers,
  callbackDataForBack,
  callbackDataForHome,
  callbackDataForSalesLeadView,
  callbackDataForCampaignStats,
  ScreenKey,
} from '../ux/callback-data';

const backRow = (): Keyboard[number] => [
  { text: '⬅️ بازگشت', callbackData: callbackDataForBack() },
  { text: '🏠 منوی اصلی', callbackData: callbackDataForHome() },
];

/** Shared footer: refresh (re-renders from the stores — never a new external call) + navigation. */
function footer(refresh: string, extra: Keyboard = []): Keyboard {
  return [
    ...extra,
    [{ text: '↻ بروزرسانی', callbackData: refresh }],
    backRow(),
  ];
}

/** The nine entries of the admin hub (§3). No entry is decorative: each one opens a real screen. */
export function adminHubKeyboard(input: {
  broadcastEnabled: boolean;
  activeBroadcasts: number;
  /** Owner-only rows (the audit trail) are rendered only for a role that may read them. */
  canAudit: boolean;
}): Keyboard {
  return footer(callbackDataForAdminHub(), [
    [
      { text: '📊 آمار', callbackData: callbackDataForAdminStats('today', 0) },
      { text: '👥 کاربران', callbackData: callbackDataForAdminUsers('all', 1) },
    ],
    [
      { text: '📢 کانال‌ها', callbackData: callbackDataForAdminChannels() },
      {
        text: '🔔 هشدارها',
        callbackData: callbackDataForAdminAlerts('all', 1),
      },
    ],
    [
      {
        text: '🛒 سرنخ‌های فروش',
        callbackData: callbackDataForAdminLeads('all', 1),
      },
      { text: '📈 کمپین‌ها', callbackData: callbackDataForAdminCampaigns(1) },
    ],
    [
      { text: '🚨 خطاها', callbackData: callbackDataForAdminErrors('open', 1) },
      {
        text: input.broadcastEnabled
          ? `📨 ارسال گروهی${input.activeBroadcasts > 0 ? ` (${input.activeBroadcasts})` : ''}`
          : '📨 ارسال گروهی (خاموش)',
        callbackData: callbackDataForAdminBroadcast(),
      },
    ],
    input.canAudit
      ? [
          { text: '🧾 رخدادنگار', callbackData: callbackDataForAdminAudit(1) },
          {
            text: '📚 تعریف شاخص‌ها',
            callbackData: callbackDataForAdminDictionary(),
          },
        ]
      : [
          {
            text: '📚 تعریف شاخص‌ها',
            callbackData: callbackDataForAdminDictionary(),
          },
        ],
  ]);
}

/** Dashboard: period presets on top, section pagination below. */
export function adminStatsKeyboard(
  preset: 'today' | '7d' | '30d' | 'all',
  section: number,
  sectionCount: number,
): Keyboard {
  const rows: Keyboard = [
    [
      { text: 'امروز', callbackData: callbackDataForAdminStats('today', 0) },
      { text: '۷ روز', callbackData: callbackDataForAdminStats('7d', 0) },
      { text: '۳۰ روز', callbackData: callbackDataForAdminStats('30d', 0) },
    ],
    [
      { text: 'از ابتدا', callbackData: callbackDataForAdminStats('all', 0) },
      {
        text: '📅 بازهٔ سفارشی',
        callbackData: callbackDataForAdminStatsCustom(),
      },
    ],
    [
      {
        text: '🩺 سلامت سامانه',
        callbackData: callbackDataForAdminStats(preset, sectionCount - 1),
      },
    ],
  ];

  const pager: Keyboard =
    sectionCount > 1
      ? [
          [
            {
              text: section > 0 ? 'قسمت قبلی' : '—',
              callbackData: callbackDataForAdminStats(
                preset,
                Math.max(0, section - 1),
              ),
            },
            {
              text: `${section + 1}/${sectionCount}`,
              callbackData: callbackDataForAdminStats(preset, section),
            },
            {
              text: section < sectionCount - 1 ? 'قسمت بعدی' : '—',
              callbackData: callbackDataForAdminStats(
                preset,
                Math.min(sectionCount - 1, section + 1),
              ),
            },
          ],
        ]
      : [];

  return footer(callbackDataForAdminStats(preset, section), [
    ...rows,
    ...pager,
  ]);
}

export function adminDictionaryKeyboard(): Keyboard {
  return footer(callbackDataForAdminDictionary(), [
    [
      {
        text: '📊 بازگشت به آمار',
        callbackData: callbackDataForAdminStats('today', 0),
      },
    ],
  ]);
}

export function adminUsersKeyboard(input: {
  filter: AdminUserFilterToken;
  page: number;
  pageCount: number;
  rows: { userId: string }[];
}): Keyboard {
  const filters: Keyboard = [
    [
      {
        text: input.filter === 'all' ? '• همه' : 'همه',
        callbackData: callbackDataForAdminUsers('all', 1),
      },
      {
        text: input.filter === 'bale' ? '• بله' : 'بله',
        callbackData: callbackDataForAdminUsers('bale', 1),
      },
      {
        text: input.filter === 'telegram' ? '• تلگرام' : 'تلگرام',
        callbackData: callbackDataForAdminUsers('telegram', 1),
      },
    ],
    [
      {
        text: input.filter === 'new' ? '• کاربران تازه' : 'کاربران تازه',
        callbackData: callbackDataForAdminUsers('new', 1),
      },
      {
        text: input.filter === 'inactive' ? '• غیرفعال‌ها' : 'غیرفعال‌ها',
        callbackData: callbackDataForAdminUsers('inactive', 1),
      },
      { text: '🔍 جست‌وجو', callbackData: callbackDataForAdminUserSearch() },
    ],
  ];

  const rows: Keyboard = input.rows.map((row) => [
    {
      text: `👤 ${row.userId}`,
      callbackData: callbackDataForAdminUser(row.userId),
    },
  ]);

  return footer(callbackDataForAdminUsers(input.filter, input.page), [
    ...filters,
    ...rows,
    ...pagination(input.page, input.pageCount, (page) =>
      callbackDataForAdminUsers(input.filter, page),
    ),
  ]);
}

export function adminUserDetailKeyboard(userId: string): Keyboard {
  return footer(callbackDataForAdminUser(userId), [
    [
      {
        text: '👥 بازگشت به فهرست',
        callbackData: callbackDataForAdminUsers('all', 1),
      },
    ],
  ]);
}

/**
 * Channel actions are *requests*: pressing them opens a confirmation screen that names exactly what
 * will happen, and only the confirmed button performs the change (§6, §12.3).
 */
export function adminChannelsKeyboard(input: {
  publishingEnabled: boolean;
  destinationCount: number;
}): Keyboard {
  const rows: Keyboard = [
    [
      {
        text: input.publishingEnabled
          ? '⛔️ غیرفعال کردن انتشار'
          : '✅ فعال کردن انتشار',
        callbackData: callbackDataForAdminPublishing(
          input.publishingEnabled ? 'disable' : 'enable',
          false,
        ),
      },
    ],
    [
      {
        text:
          input.destinationCount > 0
            ? '✉️ پیام آزمایشی به مقصد اول'
            : '✉️ پیام آزمایشی (مقصدی تنظیم نشده)',
        callbackData: callbackDataForAdminTestMessage(1, false),
      },
    ],
    [
      {
        text: '📜 تاریخچهٔ تحویل',
        callbackData: callbackDataForAdminChannelHistory(),
      },
    ],
  ];

  return footer(callbackDataForAdminChannels(), rows);
}

/** Confirmation screen of a publishing change (the second, deliberate press). */
export function adminPublishingConfirmKeyboard(
  op: 'enable' | 'disable',
): Keyboard {
  return [
    [
      {
        text: op === 'disable' ? '⛔️ بله، غیرفعال کن' : '✅ بله، فعال کن',
        callbackData: callbackDataForAdminPublishing(op, true),
      },
      { text: '⬅️ انصراف', callbackData: callbackDataForAdminChannels() },
    ],
    backRow(),
  ];
}

/** Confirmation screen of a test message — one destination, named on the screen. */
export function adminTestMessageConfirmKeyboard(destination: number): Keyboard {
  return [
    [
      {
        text: '✉️ بله، همین پیام را بفرست',
        callbackData: callbackDataForAdminTestMessage(destination, true),
      },
      { text: '⬅️ انصراف', callbackData: callbackDataForAdminChannels() },
    ],
    backRow(),
  ];
}

export function adminAlertsKeyboard(input: {
  filter: AdminAlertFilterToken;
  page: number;
  pageCount: number;
  rows: { alertId: string }[];
}): Keyboard {
  const filters: Keyboard = [
    [
      {
        text: input.filter === 'all' ? '• همه' : 'همه',
        callbackData: callbackDataForAdminAlerts('all', 1),
      },
      {
        text: input.filter === 'active' ? '• فعال' : 'فعال',
        callbackData: callbackDataForAdminAlerts('active', 1),
      },
      {
        text: input.filter === 'disabled' ? '• غیرفعال' : 'غیرفعال',
        callbackData: callbackDataForAdminAlerts('disabled', 1),
      },
    ],
    [
      {
        text: input.filter === 'triggered' ? '• فعال‌شده' : 'فعال‌شده',
        callbackData: callbackDataForAdminAlerts('triggered', 1),
      },
      {
        text: input.filter === 'bale' ? '• بله' : 'بله',
        callbackData: callbackDataForAdminAlerts('bale', 1),
      },
      {
        text: input.filter === 'telegram' ? '• تلگرام' : 'تلگرام',
        callbackData: callbackDataForAdminAlerts('telegram', 1),
      },
    ],
  ];

  const rows: Keyboard = input.rows.map((row) => [
    {
      text: `🔔 ${row.alertId}`,
      callbackData: callbackDataForAdminAlert(row.alertId),
    },
  ]);

  return footer(callbackDataForAdminAlerts(input.filter, input.page), [
    ...filters,
    ...rows,
    ...pagination(input.page, input.pageCount, (page) =>
      callbackDataForAdminAlerts(input.filter, page),
    ),
  ]);
}

export function adminAlertDetailKeyboard(input: {
  alertId: string;
  status: string;
}): Keyboard {
  const op = input.status === 'DISABLED' ? 'enable' : 'disable';
  const label =
    op === 'disable' ? '⛔️ غیرفعال کردن هشدار' : '✅ فعال کردن هشدار';

  return footer(callbackDataForAdminAlert(input.alertId), [
    // A request; the confirmation screen shows what happens before anything changes (§7).
    [
      {
        text: label,
        callbackData: callbackDataForAdminAlertState(input.alertId, op, false),
      },
    ],
    [
      {
        text: '🔔 بازگشت به فهرست',
        callbackData: callbackDataForAdminAlerts('all', 1),
      },
    ],
  ]);
}

/** Confirmation screen of an alert enable/disable. */
export function adminAlertStateConfirmKeyboard(input: {
  alertId: string;
  op: 'disable' | 'enable';
}): Keyboard {
  return [
    [
      {
        text: input.op === 'disable' ? '⛔️ بله، غیرفعال کن' : '✅ بله، فعال کن',
        callbackData: callbackDataForAdminAlertState(
          input.alertId,
          input.op,
          true,
        ),
      },
      {
        text: '⬅️ انصراف',
        callbackData: callbackDataForAdminAlert(input.alertId),
      },
    ],
    backRow(),
  ];
}

export function adminLeadsKeyboard(input: {
  filter: AdminLeadFilterToken;
  page: number;
  pageCount: number;
  rows: { leadId: string; reference: string }[];
}): Keyboard {
  const filters: Keyboard = [
    [
      {
        text: input.filter === 'all' ? '• همه' : 'همه',
        callbackData: callbackDataForAdminLeads('all', 1),
      },
      {
        text: input.filter === 'open' ? '• باز' : 'باز',
        callbackData: callbackDataForAdminLeads('open', 1),
      },
      {
        text: input.filter === 'today' ? '• امروز' : 'امروز',
        callbackData: callbackDataForAdminLeads('today', 1),
      },
    ],
    [
      {
        text: input.filter === 'converted' ? '• مشتری' : 'مشتری',
        callbackData: callbackDataForAdminLeads('converted', 1),
      },
      {
        text: input.filter === 'lost' ? '• از‌دست‌رفته' : 'از‌دست‌رفته',
        callbackData: callbackDataForAdminLeads('lost', 1),
      },
    ],
  ];

  // The operation buttons are the *existing* Phase 9 screens: no second lead pipeline (§8, §21).
  const rows: Keyboard = input.rows.map((row) => [
    {
      text: `🛒 ${row.reference} — مدیریت در فاز ۹`,
      callbackData: callbackDataForSalesLeadView(row.leadId),
    },
  ]);

  return footer(callbackDataForAdminLeads(input.filter, input.page), [
    ...filters,
    ...rows,
    ...pagination(input.page, input.pageCount, (page) =>
      callbackDataForAdminLeads(input.filter, page),
    ),
  ]);
}

export function adminCampaignsKeyboard(input: {
  page: number;
  pageCount: number;
  rows: { campaignId: string }[];
}): Keyboard {
  const rows: Keyboard = input.rows.map((row) => [
    // Phase 8 owns the funnel; the admin screen links to it instead of recomputing it (§9).
    {
      text: `📈 ${row.campaignId} — گزارش فاز ۸`,
      callbackData: callbackDataForCampaignStats(row.campaignId),
    },
    {
      text: '🚀 قیف',
      callbackData: callbackDataForAdminCampaignFunnel(row.campaignId),
    },
  ]);

  return footer(callbackDataForAdminCampaigns(input.page), [
    ...rows,
    ...pagination(input.page, input.pageCount, (page) =>
      callbackDataForAdminCampaigns(page),
    ),
  ]);
}

export function adminCampaignFunnelKeyboard(campaignId: string): Keyboard {
  return footer(callbackDataForAdminCampaignFunnel(campaignId), [
    [
      {
        text: '📈 گزارش کامل فاز ۸',
        callbackData: callbackDataForCampaignStats(campaignId),
      },
    ],
    [
      {
        text: '📈 بازگشت به کمپین‌ها',
        callbackData: callbackDataForAdminCampaigns(1),
      },
    ],
  ]);
}

export function adminErrorsKeyboard(input: {
  filter: AdminIncidentFilterToken;
  page: number;
  pageCount: number;
  rows: { incidentId: string }[];
}): Keyboard {
  const filters: Keyboard = [
    [
      {
        text: input.filter === 'open' ? '• باز' : 'باز',
        callbackData: callbackDataForAdminErrors('open', 1),
      },
      {
        text: input.filter === 'reviewed' ? '• بررسی‌شده' : 'بررسی‌شده',
        callbackData: callbackDataForAdminErrors('reviewed', 1),
      },
      {
        text: input.filter === 'resolved' ? '• رفع‌شده' : 'رفع‌شده',
        callbackData: callbackDataForAdminErrors('resolved', 1),
      },
    ],
    [
      {
        text:
          input.filter === 'retryable-open'
            ? '• قابل تلاش دوباره'
            : 'قابل تلاش دوباره',
        callbackData: callbackDataForAdminErrors('retryable-open', 1),
      },
      {
        text: input.filter === 'all' ? '• همه' : 'همه',
        callbackData: callbackDataForAdminErrors('all', 1),
      },
    ],
  ];

  const rows: Keyboard = input.rows.map((row) => [
    {
      text: `🚨 ${row.incidentId}`,
      callbackData: callbackDataForAdminError(row.incidentId),
    },
  ]);

  return footer(callbackDataForAdminErrors(input.filter, input.page), [
    ...filters,
    ...rows,
    ...pagination(input.page, input.pageCount, (page) =>
      callbackDataForAdminErrors(input.filter, page),
    ),
  ]);
}

export function adminIncidentDetailKeyboard(input: {
  incidentId: string;
  status: string;
  retryable: boolean;
}): Keyboard {
  const rows: Keyboard = [
    [
      {
        text: '👀 بررسی‌شده',
        callbackData: callbackDataForAdminErrorAct(input.incidentId, 'review'),
      },
      {
        text: '✅ رفع‌شده',
        callbackData: callbackDataForAdminErrorAct(input.incidentId, 'resolve'),
      },
    ],
    ...(input.status === 'RESOLVED'
      ? [
          [
            {
              text: '↩️ بازگشایی',
              callbackData: callbackDataForAdminErrorAct(
                input.incidentId,
                'reopen',
              ),
            },
          ],
        ]
      : []),
    ...(input.retryable
      ? [
          [
            {
              text: '♻️ تلاش دوبارهٔ ایمن',
              callbackData: callbackDataForAdminErrorRetry(input.incidentId),
            },
          ],
        ]
      : []),
  ];

  return footer(callbackDataForAdminError(input.incidentId), [
    ...rows,
    [
      {
        text: '🚨 بازگشت به فهرست',
        callbackData: callbackDataForAdminErrors('open', 1),
      },
    ],
  ]);
}

export function adminBroadcastKeyboard(input: {
  enabled: boolean;
  activeCount: number;
  preparedReference: string | null;
  lastReference: string | null;
}): Keyboard {
  const listButton = {
    text: '📋 فهرست ارسال‌ها',
    callbackData: callbackDataForAdminBroadcastList(),
  };
  const rows: Keyboard = [
    input.enabled
      ? [
          {
            text: '🆕 ارسال تازه',
            callbackData: callbackDataForAdminBroadcastAudience('all'),
          },
          listButton,
        ]
      : [listButton],
    ...(input.preparedReference
      ? [
          [
            {
              text: `✅ تأیید و شروع ${input.preparedReference}`,
              callbackData: callbackDataForAdminBroadcastStart(
                input.preparedReference,
              ),
            },
            {
              text: '⛔️ لغو',
              callbackData: callbackDataForAdminBroadcastCancel(
                input.preparedReference,
              ),
            },
          ],
        ]
      : []),
    ...(input.lastReference
      ? [
          [
            {
              text: `📄 گزارش ${input.lastReference}`,
              callbackData: callbackDataForAdminBroadcastReport(
                input.lastReference,
              ),
            },
            {
              text: '♻️ تلاش دوباره برای ناموفق‌ها',
              callbackData: callbackDataForAdminBroadcastRetry(
                input.lastReference,
              ),
            },
          ],
        ]
      : []),
  ];

  return footer(callbackDataForAdminBroadcast(), rows);
}

export function adminBroadcastAudienceKeyboard(enabled: boolean): Keyboard {
  if (!enabled) {
    return footer(callbackDataForAdminBroadcast(), [
      [
        {
          text: '📋 فهرست ارسال‌ها',
          callbackData: callbackDataForAdminBroadcastList(),
        },
      ],
    ]);
  }

  const audiences: {
    label: string;
    audience: AdminAudienceToken;
    days?: number;
  }[] = [
    { label: '👥 همهٔ هویت‌های قابل‌دسترس', audience: 'all' },
    { label: 'بله', audience: 'bale' },
    { label: 'تلگرام', audience: 'telegram' },
    { label: 'فعال در ۷ روز', audience: 'active', days: 7 },
    { label: 'فعال در ۳۰ روز', audience: 'active', days: 30 },
    { label: 'غیرفعال در ۳۰ روز', audience: 'inactive', days: 30 },
  ];

  return footer(callbackDataForAdminBroadcast(), [
    ...audiences.map((entry) => [
      {
        text: entry.label,
        callbackData: callbackDataForAdminBroadcastAudience(
          entry.audience,
          entry.days ?? null,
        ),
      },
    ]),
  ]);
}

export function adminBroadcastPreviewKeyboard(): Keyboard {
  return footer(callbackDataForAdminBroadcastPreview(), [
    [
      {
        text: '✍️ تغییر متن',
        callbackData: callbackDataForAdminBroadcastText(),
      },
    ],
    [
      {
        text: '📌 تثبیت پیش‌نویس (بدون ارسال)',
        callbackData: callbackDataForAdminBroadcastSave(),
      },
    ],
  ]);
}

export function adminBroadcastConfirmKeyboard(reference: string): Keyboard {
  return footer(callbackDataForAdminBroadcastStart(reference), [
    [
      {
        text: '✅ تأیید و شروع ارسال',
        callbackData: callbackDataForAdminBroadcastStart(reference),
      },
    ],
    [
      {
        text: '⛔️ لغو',
        callbackData: callbackDataForAdminBroadcastCancel(reference),
      },
    ],
    [
      {
        text: '📄 گزارش',
        callbackData: callbackDataForAdminBroadcastReport(reference),
      },
    ],
  ]);
}

export function adminBroadcastReportKeyboard(reference: string): Keyboard {
  return footer(callbackDataForAdminBroadcastReport(reference), [
    [
      {
        text: '♻️ تلاش دوباره برای ناموفق‌ها',
        callbackData: callbackDataForAdminBroadcastRetry(reference),
      },
      {
        text: '⛔️ لغو باقی‌مانده',
        callbackData: callbackDataForAdminBroadcastCancel(reference),
      },
    ],
    [
      {
        text: '📨 بازگشت به ارسال گروهی',
        callbackData: callbackDataForAdminBroadcast(),
      },
    ],
  ]);
}

export function adminAuditKeyboard(page: number, pageCount: number): Keyboard {
  return footer(callbackDataForAdminAudit(page), [
    ...pagination(page, pageCount, (target) =>
      callbackDataForAdminAudit(target),
    ),
  ]);
}

export function adminPeriodInputKeyboard(): Keyboard {
  return [
    [
      { text: 'امروز', callbackData: callbackDataForAdminStats('today', 0) },
      { text: '۷ روز', callbackData: callbackDataForAdminStats('7d', 0) },
      { text: '۳۰ روز', callbackData: callbackDataForAdminStats('30d', 0) },
    ],
    backRow(),
  ];
}

export function adminTextInputKeyboard(cancel: () => string): Keyboard {
  return [[{ text: '⛔️ انصراف', callbackData: cancel() }], backRow()];
}

/** Standard pagination row: `page` is 1-based; disabled directions are simply not rendered. */
function pagination(
  page: number,
  pageCount: number,
  dataFor: (page: number) => string,
): Keyboard {
  if (pageCount <= 1) {
    return [];
  }

  const row = [
    ...(page > 1 ? [{ text: '⬅️ قبلی', callbackData: dataFor(page - 1) }] : []),
    { text: `${page}/${pageCount}`, callbackData: dataFor(page) },
    ...(page < pageCount
      ? [{ text: 'بعدی ➡️', callbackData: dataFor(page + 1) }]
      : []),
  ];

  return [row];
}

/** Footer for a screen that is reached from the hub but is not one of the nine entries. */
export function adminHubBackRow(): Keyboard {
  return [
    [{ text: '⚙️ بازگشت به مدیریت', callbackData: callbackDataForAdminHub() }],
  ];
}

export type { ScreenKey };
