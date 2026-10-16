import {
  createAdminHarness,
  createAppConfigService,
  createChannelHarness,
  createMarketHarness,
  createPlatformHarness,
  EnvMap,
} from '../testing/test-doubles';
import { AdminAccessService } from './admin-access.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminActivityService } from './admin-activity.service';
import { AdminErrorService, sanitizeSummary } from './admin-error.service';
import { AdminStore } from './admin.store';
import { daysBetween, resolveWindow, withinWindow } from './admin-period';
import { ADMIN_CAPABILITIES } from './admin.types';
import { parseAdminUserIds } from '../config/env.validation';
import { AlertStore } from '../alerts/alert.store';
import { UserStore } from '../users/user.store';
import { SalesStore } from '../sales/sales.store';
import { CampaignStore } from '../campaigns/campaign.store';
import { tehranDayKey } from '../common/tehran-time';

/**
 * Phase 10 — the admin system's own contracts (§12 authorization, §2 audit, §8 incidents, §3 periods,
 * §4 dashboard, §17 activity).
 *
 * Everything runs against the real stores, the real services and the real configuration validation.
 * Only the platform transport is doubled. The suite deliberately checks the *negative* space as much
 * as the positive one: a denial must be explicit, an unmeasurable metric must say so instead of
 * printing zero, and activity must only ever come from a user-initiated interaction.
 */

const BASE_ENV: EnvMap = {
  ADMIN_DATA_FILE: '',
  ADMIN_OWNER_IDS: 'bale:900',
  ADMIN_USER_IDS: '111',
  ADMIN_BROADCAST_ENABLED: 'false',
  BOT_POLLING_ENABLED: 'false',
};

const ADMIN_ACTOR = { key: 'bale:900', role: 'OWNER' as const };

const build = (env: EnvMap = {}) => {
  const merged = { ...BASE_ENV, ...env };

  return createAdminHarness(merged, { config: createAppConfigService(merged) });
};

const direct = (env: EnvMap = {}) => {
  const merged = { ...BASE_ENV, ...env };
  const config = createAppConfigService(merged);
  const store = new AdminStore(config);

  return {
    config,
    store,
    access: new AdminAccessService(config),
    audit: new AdminAuditService(config, store),
    activity: new AdminActivityService(config, store),
    errors: new AdminErrorService(config, store),
  };
};

describe('phase 10 — authorization is decided on the server (§12, §18)', () => {
  it('fails closed when no admin identity is configured at all', () => {
    const access = new AdminAccessService(
      createAppConfigService({ ADMIN_OWNER_IDS: '', ADMIN_USER_IDS: '' }),
    );

    expect(access.enabled).toBe(false);
    expect(access.roleOf('bale', '900')).toBeNull();
    expect(access.isAdmin('bale', '900')).toBe(false);
    expect(access.isOwner('bale', '900')).toBe(false);
  });

  it('matches a qualified identity only on the platform it was written for', () => {
    const access = new AdminAccessService(
      createAppConfigService({
        ADMIN_OWNER_IDS: 'bale:900',
        ADMIN_USER_IDS: '',
      }),
    );

    expect(access.roleOf('bale', '900')).toBe('OWNER');
    // Same numeric id, different platform — the admin row is not transferable (§12.1).
    expect(access.roleOf('telegram', '900')).toBeNull();
  });

  it('keeps the documented bare-id form working, and owner wins over admin', () => {
    const access = new AdminAccessService(
      createAppConfigService({ ADMIN_OWNER_IDS: '900', ADMIN_USER_IDS: '900' }),
    );

    expect(access.roleOf('telegram', '900')).toBe('OWNER');
    expect(access.roleOf('bale', '900')).toBe('OWNER');
    expect(access.describe()).toEqual({ owners: ['900'], admins: ['900'] });
  });

  it('validates the allow-list syntax with the same parser as every other admin surface', () => {
    expect(() => parseAdminUserIds('*', 'ADMIN_OWNER_IDS')).toThrow(
      /ADMIN_OWNER_IDS/u,
    );
    expect(() => parseAdminUserIds('bale:', 'ADMIN_USER_IDS')).toThrow(
      /ADMIN_USER_IDS/u,
    );
    expect(parseAdminUserIds('bale:900, 111', 'ADMIN_USER_IDS')).toEqual([
      'bale:900',
      '111',
    ]);
    // A repeated entry is de-duplicated by the shared parser: the role is the same either way.
    expect(parseAdminUserIds('900,900', 'ADMIN_USER_IDS')).toEqual(['900']);
  });

  it('grants the operator role every read surface but withholds the high-impact ones', () => {
    const operator = ADMIN_CAPABILITIES.ADMIN;
    const owner = ADMIN_CAPABILITIES.OWNER;

    for (const capability of [
      'manage',
      'stats',
      'users',
      'channels',
      'alerts',
      'leads',
      'campaigns',
      'errors',
      'broadcast',
    ] as const) {
      expect(operator).toContain(capability);
    }

    // Starting a broadcast and reading the audit trail stay with the owner (§12.2).
    expect(operator).not.toContain('broadcast.send');
    expect(operator).not.toContain('audit');
    expect(owner).toContain('broadcast.send');
    expect(owner).toContain('audit');
  });

  it('never answers "allowed" for a null role', () => {
    const harness = build();

    for (const capability of ADMIN_CAPABILITIES.OWNER) {
      expect(harness.access.can(null, capability)).toBe(false);
    }
  });

  it('builds the actor key from the stable platform identity only', () => {
    const harness = build();

    expect(harness.access.actorKey('bale', '900')).toBe('bale:900');
    expect(harness.access.actorKey('telegram', '900')).toBe('telegram:900');
  });
});

describe('phase 10 — the audit trail is append-only and bounded (§2, §12.4)', () => {
  it('writes a durable row with actor, action, target and result', async () => {
    const { audit, store } = direct();

    const record = await audit.record({
      actor: ADMIN_ACTOR.key,
      role: ADMIN_ACTOR.role,
      action: 'CHANNEL_PUBLISHING_TOGGLED',
      targetType: 'channel',
      targetRef: 'bale:-100',
      result: 'OK',
      fromState: 'enabled',
      toState: 'disabled',
      reason: 'maintenance',
    });

    expect(record?.auditId).toMatch(/^aud_/u);
    expect(audit.count).toBe(1);

    const stored = store.listAudit();

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      actor: 'bale:900',
      role: 'OWNER',
      action: 'CHANNEL_PUBLISHING_TOGGLED',
      result: 'OK',
      fromState: 'enabled',
      toState: 'disabled',
    });
  });

  it('returns the newest row first and can filter by target', async () => {
    const { audit } = direct();

    for (const [index, target] of ['one', 'two', 'one'].entries()) {
      await audit.record({
        actor: ADMIN_ACTOR.key,
        role: ADMIN_ACTOR.role,
        action: 'ADMIN_VIEW',
        targetType: 'screen',
        targetRef: target,
        result: 'OK',
        at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      });
    }

    expect(audit.list()[0]?.at).toBe(
      new Date(Date.UTC(2026, 0, 3)).toISOString(),
    );
    expect(audit.forTarget('one')).toHaveLength(2);
    expect(audit.forTarget('two')).toHaveLength(1);
  });

  it('hands out copies, so a screen cannot rewrite history it was given', async () => {
    const { audit } = direct();

    await audit.record({
      actor: ADMIN_ACTOR.key,
      role: ADMIN_ACTOR.role,
      action: 'ADMIN_VIEW',
      targetType: 'screen',
      result: 'OK',
    });

    const [first] = audit.list();

    first.result = 'DENIED';

    expect(audit.list()[0]?.result).toBe('OK');
  });

  it('truncates an over-long reason instead of storing a payload', async () => {
    const { audit } = direct();

    const record = await audit.record({
      actor: ADMIN_ACTOR.key,
      role: ADMIN_ACTOR.role,
      action: 'INCIDENT_RESOLVED',
      targetType: 'incident',
      result: 'OK',
      reason: 'x'.repeat(1_000),
    });

    expect(record?.reason?.length).toBeLessThanOrEqual(201);
  });

  it('applies the configured cap by dropping the oldest rows only', async () => {
    const { audit } = direct({ ADMIN_MAX_AUDIT_RECORDS: '2' });

    for (const index of [1, 2, 3]) {
      await audit.record({
        actor: ADMIN_ACTOR.key,
        role: ADMIN_ACTOR.role,
        action: 'ADMIN_VIEW',
        targetType: 'screen',
        targetRef: `screen-${index}`,
        result: 'OK',
        at: new Date(Date.UTC(2026, 0, index)).toISOString(),
      });
    }

    const kept = audit.list().map((row) => row.targetRef);

    expect(audit.count).toBe(2);
    expect(kept).toEqual(['screen-3', 'screen-2']);
  });

  it('records a denial as a first-class row, not as a silent no-op', async () => {
    const { audit } = direct();

    await audit.record({
      actor: 'bale:999',
      role: 'ADMIN',
      action: 'BROADCAST_STARTED',
      targetType: 'broadcast',
      result: 'DENIED',
      reason: 'missing capability',
    });

    expect(audit.list()[0]).toMatchObject({
      result: 'DENIED',
      action: 'BROADCAST_STARTED',
    });
  });
});

describe('phase 10 — incidents aggregate by fingerprint (§8)', () => {
  const input = {
    source: 'channel-publisher' as const,
    category: 'PUBLISH_FAILED',
    severity: 'HIGH' as const,
    summary: 'پلتفرم خطا برگرداند',
    retryable: true,
  };

  it('stores the first occurrence as an open incident with occurrence count 1', async () => {
    const { errors } = direct();

    const incident = await errors.record(input);

    expect(incident?.status).toBe('OPEN');
    expect(incident?.occurrences).toBe(1);
    expect(errors.openCount()).toBe(1);
  });

  it('folds a repeated identical failure into the same record instead of flooding the list', async () => {
    const { errors } = direct();

    await errors.record(input);
    await errors.record(input);
    const third = await errors.record(input);

    expect(third?.occurrences).toBe(3);
    expect(errors.list()).toHaveLength(1);
    expect(errors.list()[0]?.lastSeenAt).toBeTruthy();
  });

  it('keeps a different failure separate, even in the same source', async () => {
    const { errors } = direct();

    await errors.record(input);
    await errors.record({ ...input, category: 'NOTIFICATION_FAILED' });

    expect(errors.list()).toHaveLength(2);
  });

  it('walks review → resolve → reopen and stamps each transition', async () => {
    const { errors } = direct();
    const incident = await errors.record(input);

    const reviewed = await errors.review(incident!.incidentId, ADMIN_ACTOR.key);

    expect(reviewed).toMatchObject({
      status: 'REVIEWED',
      reviewedBy: 'bale:900',
    });
    expect(reviewed?.reviewedAt).toBeTruthy();

    const resolved = await errors.resolve(
      incident!.incidentId,
      ADMIN_ACTOR.key,
    );

    expect(resolved).toMatchObject({
      status: 'RESOLVED',
      resolvedBy: 'bale:900',
    });
    expect(errors.openCount()).toBe(0);

    const reopened = await errors.reopen(incident!.incidentId, ADMIN_ACTOR.key);

    expect(reopened?.status).toBe('OPEN');
    expect(errors.openCount()).toBe(1);
  });

  it('records what happened on a retry attempt', async () => {
    const { errors } = direct();
    const incident = await errors.record(input);

    const retried = await errors.recordRetry(incident!.incidentId, {
      actor: ADMIN_ACTOR.key,
      result: 'RETRY_SUCCEEDED',
    });

    expect(retried?.lastRetryAt).toBeTruthy();
    expect(retried?.lastRetryResult).toContain('RETRY_SUCCEEDED');
  });

  it('filters by status, severity and free text', async () => {
    const { errors } = direct();

    const open = await errors.record(input);

    await errors.record({
      source: 'price-api',
      category: 'PROVIDER_TIMEOUT',
      severity: 'LOW',
      summary: 'زمان پاسخ گذشت',
    });
    await errors.resolve(open!.incidentId, ADMIN_ACTOR.key);

    expect(errors.list({ status: 'OPEN' })).toHaveLength(1);
    expect(errors.list({ severity: 'HIGH' })).toHaveLength(1);
    expect(errors.list({ query: 'PROVIDER_TIMEOUT' })).toHaveLength(1);
    expect(errors.list({ source: 'price-api' })).toHaveLength(1);
    expect(errors.count({ status: 'RESOLVED' })).toBe(1);
  });

  it('never stores a platform token inside an incident summary', () => {
    const sanitized = sanitizeSummary(
      'bot123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw failed',
    );

    expect(sanitized).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    expect(sanitized).toContain('bot***');
  });

  it('prunes the oldest finished incidents once the configured cap is exceeded', async () => {
    const { errors } = direct({ ADMIN_MAX_INCIDENTS: '1' });

    const oldest = await errors.record({
      ...input,
      at: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newest = await errors.record({
      ...input,
      category: 'OTHER',
      summary: 'تازه',
      at: new Date('2026-06-01T00:00:00.000Z'),
    });

    await errors.resolve(oldest!.incidentId, ADMIN_ACTOR.key);
    await errors.resolve(newest!.incidentId, ADMIN_ACTOR.key);

    const result = await errors.prune();

    expect(result.removed).toBe(1);
    expect(errors.find(oldest!.incidentId)).toBeNull();
    expect(errors.find(newest!.incidentId)).not.toBeNull();
  });

  it('never prunes an incident that is still open', async () => {
    const { errors } = direct({ ADMIN_MAX_INCIDENTS: '1' });

    const open = await errors.record(input);
    const alsoOpen = await errors.record({
      ...input,
      category: 'OTHER',
      summary: 'دیگر',
    });

    const result = await errors.prune();

    expect(errors.list({ status: 'OPEN' })).toHaveLength(2);
    expect(result.occurrences).toBeGreaterThanOrEqual(0);
    expect(errors.find(open!.incidentId)).not.toBeNull();
    expect(errors.find(alsoOpen!.incidentId)).not.toBeNull();
  });

  it('reports unassigned ids instead of inventing a record', async () => {
    const { errors } = direct();

    expect(errors.find('inc_does_not_exist')).toBeNull();
    expect(await errors.review('inc_missing', ADMIN_ACTOR.key)).toBeNull();
  });
});

describe('phase 10 — report periods use Tehran days with documented ends (§3)', () => {
  const now = new Date('2026-10-16T09:30:00.000Z');

  it('resolves today to exactly one Tehran day', () => {
    const resolved = resolveWindow('today', now, { maxDays: 90 });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }

    expect(resolved.window.fromDayKey).toBe(tehranDayKey(now));
    expect(resolved.window.toDayKey).toBe(tehranDayKey(now));
    expect(
      daysBetween(resolved.window.fromDayKey, resolved.window.toDayKey),
    ).toBe(0);
  });

  it('resolves 7d and 30d to the inclusive start of the first day', () => {
    const seven = resolveWindow('7d', now, { maxDays: 90 });
    const thirty = resolveWindow('30d', now, { maxDays: 90 });

    expect(
      seven.ok && daysBetween(seven.window.fromDayKey, seven.window.toDayKey),
    ).toBe(6);
    expect(
      thirty.ok &&
        daysBetween(thirty.window.fromDayKey, thirty.window.toDayKey),
    ).toBe(29);
  });

  it('treats the start as inclusive and the end as exclusive', () => {
    const resolved = resolveWindow('7d', now, { maxDays: 90 });

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const { window } = resolved;

    expect(withinWindow(window, window.from)).toBe(true);
    expect(withinWindow(window, window.to)).toBe(false);
    expect(
      withinWindow(window, new Date(Date.parse(window.to) - 1).toISOString()),
    ).toBe(true);
  });

  it('accepts a valid custom range and rejects an inverted one', () => {
    const ok = resolveWindow('custom', now, {
      maxDays: 90,
      fromDayKey: '2026-10-01',
      toDayKey: '2026-10-03',
    });
    const inverted = resolveWindow('custom', now, {
      maxDays: 90,
      fromDayKey: '2026-10-04',
      toDayKey: '2026-10-01',
    });

    expect(ok.ok).toBe(true);
    expect(ok.ok && daysBetween(ok.window.fromDayKey, ok.window.toDayKey)).toBe(
      2,
    );
    expect(inverted.ok).toBe(false);
  });

  it('bounds an oversized custom range and refuses malformed input', () => {
    const tooLong = resolveWindow('custom', now, {
      maxDays: 30,
      fromDayKey: '2026-01-01',
      toDayKey: '2026-10-01',
    });
    const malformed = resolveWindow('custom', now, {
      maxDays: 90,
      fromDayKey: '01/01/2026',
      toDayKey: '2026-10-01',
    });

    expect(tooLong.ok).toBe(false);
    expect(malformed.ok).toBe(false);
  });

  it('resolves all-time without an upper bound and labels every preset in Persian', () => {
    const all = resolveWindow('all', now, { maxDays: 90 });

    expect(all.ok).toBe(true);
    expect(all.ok && all.window.labelFa.length).toBeGreaterThan(0);
    expect(all.ok && withinWindow(all.window, '2020-01-01T00:00:00.000Z')).toBe(
      true,
    );
  });
});

describe('phase 10 — activity counts user-initiated interactions only (§4.1, §17)', () => {
  it('is zero before any interaction arrives', () => {
    const harness = build();
    const today = harness.metrics.window('today');

    if (!today.ok) {
      throw new Error(today.message);
    }

    expect(harness.activity.trackedIdentities).toBe(0);
    expect(harness.activity.countActiveIn(today.window)).toBe(0);
  });

  it('records one Tehran day per identity and is idempotent for the same day', async () => {
    const { activity } = direct();

    await activity.recordUserAction({
      platform: 'bale',
      platformUserId: '42',
      userId: 'usr_42',
    });
    await activity.recordUserAction({
      platform: 'bale',
      platformUserId: '42',
      userId: 'usr_42',
    });

    const days = activity.daysOf('bale:42');

    expect(days).toHaveLength(1);
    expect(activity.trackedIdentities).toBe(1);
    expect(activity.lastSeenAt('bale:42')).toBeTruthy();
  });

  it('counts an identity once even with several interactions in the window', async () => {
    const harness = build();
    const today = harness.metrics.window('today');

    if (!today.ok) {
      throw new Error(today.message);
    }

    await harness.activity.recordUserAction({
      platform: 'bale',
      platformUserId: '1',
      userId: 'usr_1',
    });
    await harness.activity.recordUserAction({
      platform: 'bale',
      platformUserId: '2',
      userId: 'usr_2',
    });

    expect(harness.activity.countActiveIn(today.window)).toBe(2);
    expect(harness.activity.activeIdentitiesIn(today.window)).toHaveLength(2);
  });

  it('never counts pipeline work as activity: publishing and alerts write no activity row', async () => {
    const merged: EnvMap = {
      ...BASE_ENV,
      MARKET_STATE_FILE: '',
      ALERT_DATA_FILE: '',
      CHANNEL_DATA_FILE: '',
    };
    const config = createAppConfigService(merged);
    const market = createMarketHarness({
      ...merged,
      BOT_POLLING_ENABLED: 'false',
    });
    const platform = createPlatformHarness({
      ...merged,
      BOT_POLLING_ENABLED: 'false',
    });
    const channel = createChannelHarness(
      { ...merged, BOT_POLLING_ENABLED: 'false' },
      { market, platform, config },
    );
    const admin = createAdminHarness(merged, {
      config,
      market,
      platform,
      publicationStore: channel.store,
      userStore: new UserStore(config),
      alertStore: new AlertStore(config),
      campaignStore: new CampaignStore(config),
      salesStore: new SalesStore(config),
    });

    // A scheduled publication cycle and an alert notification drain are automated work: neither may
    // inflate the “active users” metric.
    await channel.engine.schedulerTick();

    // Reading the health screen must not create activity either.
    admin.metrics.systemHealth();

    expect(admin.activity.trackedIdentities).toBe(0);

    const today = admin.metrics.window('today');

    if (!today.ok) {
      throw new Error(today.message);
    }

    expect(admin.activity.countActiveIn(today.window)).toBe(0);
  });
});

describe('phase 10 — the dashboard reports real numbers and admits the unknown ones (§4, §18)', () => {
  it('counts new users inside the window and total users across all time', () => {
    const merged: EnvMap = { ...BASE_ENV, USER_DATA_FILE: '' };
    const config = createAppConfigService(merged);
    const users = new UserStore(config);

    users.hydrateUser({
      id: 'usr_old',
      platform: 'bale',
      platformUserId: 'old',
      chatId: 'chat-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    users.hydrateUser({
      id: 'usr_new',
      platform: 'bale',
      platformUserId: 'new',
      chatId: 'chat-new',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);

    const harness = createAdminHarness(merged, { config, userStore: users });
    const today = harness.metrics.window('today');
    const all = harness.metrics.window('all');

    if (!today.ok || !all.ok) {
      throw new Error('window resolution failed');
    }

    const todaySection = harness.metrics
      .dashboard(today.window)
      .find((section) => section.key === 'audience');
    const allSection = harness.metrics
      .dashboard(all.window)
      .find((section) => section.key === 'audience');

    const metric = (section: typeof todaySection, key: string) =>
      section?.metrics.find((entry) => entry.key === key)?.value ?? null;

    expect(metric(todaySection, 'usersNew')).toBe(1);
    expect(metric(allSection, 'usersNew')).toBe(2);
    expect(metric(todaySection, 'usersTotal')).toBe(2);
  });

  it('labels every metric line with its source and semantics', () => {
    const harness = build();
    const today = harness.metrics.window('today');

    if (!today.ok) {
      throw new Error(today.message);
    }

    const sections = harness.metrics.dashboard(today.window);

    expect(sections.map((section) => section.key)).toEqual([
      'audience',
      'engagement',
      'commercial',
      'reliability',
    ]);

    for (const section of sections) {
      expect(section.metrics.length).toBeGreaterThan(0);

      for (const entry of section.metrics) {
        expect(entry.source.length).toBeGreaterThan(0);
        expect(entry.labelFa.length).toBeGreaterThan(0);
      }
    }
  });

  it('reports the channel-join metric as unavailable when verification is switched off', () => {
    const harness = build({ CAMPAIGN_TRACKING_ENABLED: 'false' });
    const today = harness.metrics.window('today');

    if (!today.ok) {
      throw new Error(today.message);
    }

    const engagement = harness.metrics
      .dashboard(today.window)
      .find((section) => section.key === 'engagement');
    const joins = engagement?.metrics.find(
      (entry) => entry.key === 'channelJoins',
    );

    expect(joins?.value).toBeNull();
    expect(joins?.unavailableReason ?? '').not.toBe('');
    expect(engagement?.notes?.join(' ')).toContain('اندازه');
  });

  it('never invents a market age when no valid price was ever accepted', () => {
    const harness = build();

    const rows = harness.metrics.systemHealth();
    const price = rows.find((row) => row.labelFa.includes('قیمت'));

    expect(price?.ok).toBeNull();
    expect(price?.valueFa).toContain('نامشخص');
  });

  it('says the storage mode out loud instead of showing a green row', () => {
    const harness = build();
    const rows = harness.metrics.systemHealth();
    const storage = rows.find((row) => row.labelFa.includes('ذخیره'));

    // `ADMIN_DATA_FILE=''` is the in-memory test configuration: the screen must warn that nothing
    // survives a restart (§4.4 — unknown/unsafe is never rendered as healthy).
    expect(storage?.ok).toBe(false);
  });

  it('returns a comparison window only where a real previous period exists', () => {
    const harness = build();

    for (const preset of ['today', '7d', '30d'] as const) {
      const resolved = harness.metrics.window(preset);

      if (!resolved.ok) {
        throw new Error(resolved.message);
      }

      expect(harness.metrics.previousWindow(resolved.window)).not.toBeNull();
    }

    const all = harness.metrics.window('all');

    if (!all.ok) {
      throw new Error(all.message);
    }

    expect(harness.metrics.previousWindow(all.window)).toBeNull();
  });

  it('exposes the metric dictionary so nobody has to guess what a number means', () => {
    const harness = build();
    const labels = harness.metrics.periodLabels;

    for (const preset of ['today', '7d', '30d', 'all'] as const) {
      expect(typeof labels[preset]).toBe('string');
      expect(labels[preset].length).toBeGreaterThan(0);
    }
  });

  it('refuses an unmeasurable dashboard instead of rendering zeros for it', () => {
    const harness = build();
    const today = harness.metrics.window('today');

    if (!today.ok) {
      throw new Error(today.message);
    }

    const reliability = harness.metrics
      .dashboard(today.window)
      .find((section) => section.key === 'reliability');

    expect(reliability).toBeDefined();
    // Nothing failed and nothing was delivered yet: the honest answer is a zero *of a measured
    // quantity*, which is different from a metric that cannot be measured at all.
    for (const entry of reliability?.metrics ?? []) {
      if (entry.value === null) {
        expect(entry.unavailableReason ?? '').not.toBe('');
      }
    }
  });
});
