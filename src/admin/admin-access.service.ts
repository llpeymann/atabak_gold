/**
 * Phase 10 — administrative authorization (§12).
 *
 * Rules, in the order they are enforced:
 *
 *  1. **The identity is the platform-qualified user id** (`bale:12345`), read from the platform
 *     adapter — never from message text, a display name, a callback payload or a client-supplied
 *     role. The same numeric id on the other platform is a different person and is not an
 *     administrator (§12.1).
 *  2. **Fail closed.** Anything that is not an explicit allow-list match is `null`, and `can()`
 *     returns `false` for `null`. There is no permissive default and no “developer mode”.
 *  3. **Capabilities, not screens.** Hiding a button is presentation; every privileged operation
 *     re-checks the capability on the server side at the moment it executes (§12.3).
 *
 * The allow-lists reuse the project's existing convention (`<platform>:<id>` or a bare `<id>` for
 * “on every platform”), parsed by the same `parseAdminUserIds` helper as the Phase 5/8/9 surfaces, so
 * the configuration syntax cannot drift between phases.
 */

import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';
import { Platform } from '../platform/platform.types';
import { ADMIN_CAPABILITIES, AdminCapability, AdminRole } from './admin.types';

@Injectable()
export class AdminAccessService {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Owners (`ADMIN_OWNER_IDS`). When the project configures no owner, the existing administrator
   * list is promoted — a single-owner deployment must not need a second variable to work (§12.2).
   */
  get ownerIds(): readonly string[] {
    const owners = this.config.adminOwnerIds;

    if (owners.length > 0) {
      return owners;
    }

    const admins = this.config.adminUserIds;

    return admins.length > 0 ? admins : this.config.channelAdminUserIds;
  }

  /** Operators (`ADMIN_USER_IDS`, falling back to the existing administrator allow-list). */
  get adminIds(): readonly string[] {
    const admins = this.config.adminUserIds;

    return admins.length > 0 ? admins : this.config.channelAdminUserIds;
  }

  /** The surface exists only when at least one administrator is configured (§12.1). */
  get enabled(): boolean {
    return this.ownerIds.length > 0 || this.adminIds.length > 0;
  }

  /** `null` for a plain user — the only value that can be compared against a capability. */
  roleOf(platform: Platform, platformUserId: string): AdminRole | null {
    if (matches(this.ownerIds, platform, platformUserId)) {
      return 'OWNER';
    }

    if (matches(this.adminIds, platform, platformUserId)) {
      return 'ADMIN';
    }

    return null;
  }

  isAdmin(platform: Platform, platformUserId: string): boolean {
    return this.roleOf(platform, platformUserId) !== null;
  }

  isOwner(platform: Platform, platformUserId: string): boolean {
    return this.roleOf(platform, platformUserId) === 'OWNER';
  }

  /** Fail closed: an unknown role can do nothing, and an unknown capability is never granted. */
  can(role: AdminRole | null, capability: AdminCapability): boolean {
    if (role === null) {
      return false;
    }

    return ADMIN_CAPABILITIES[role].includes(capability);
  }

  /** Actor key written into the audit trail (`<platform>:<platformUserId>`). */
  actorKey(platform: Platform, platformUserId: string): string {
    return `${platform}:${platformUserId}`;
  }

  /**
   * What the management screen may print about the *configuration*: which ids are allowed and in
   * which role. These are operator identities the owner configured — not secrets — and seeing them
   * is what makes “who can do what” auditable from inside the bot.
   */
  describe(): { owners: string[]; admins: string[] } {
    return { owners: [...this.ownerIds], admins: [...this.adminIds] };
  }
}

function matches(
  entries: readonly string[],
  platform: Platform,
  platformUserId: string,
): boolean {
  return (
    entries.includes(`${platform}:${platformUserId}`) ||
    entries.includes(platformUserId)
  );
}
