import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

import { escapeHtml } from '../common/html';
import { CampaignService } from './campaign.service';
import { isTrackingToken } from './campaign-token';

/**
 * Phase 8 — the single tracked-redirect endpoint (`GET /c/:token`, §7.2/§7.3).
 *
 * Three properties matter more than the redirect itself:
 *
 *  1. **Never an open redirect.** The target is not taken from the request at all: it is recomputed
 *     from configuration through `CampaignService.targetFor`, which knows only the five bot routes and
 *     the configured channel URLs. A token can therefore never forward anybody to a third-party host.
 *  2. **A raw request is not a human click.** The user agent is used *only* to classify the request
 *     (`HUMAN` / `PREVIEW` / `UNCLASSIFIED`); it is never stored, logged or combined with an address.
 *     Link previews and crawlers are forwarded so sharing works, and are counted as rejected
 *     ingestion instead of clicks.
 *  3. **Unknown or inactive references are answered, not guessed**: `404` for an unknown token, `410`
 *     for a campaign that no longer accepts traffic — in both cases with no redirect at all.
 *
 * Nothing here is admin-related: a redirect carries no authorization and grants none.
 */
@Controller()
export class CampaignController {
  private readonly logger = new Logger(CampaignController.name);

  constructor(private readonly campaigns: CampaignService) {}

  @Get('c/:token')
  @Header('Cache-Control', 'no-store')
  async track(
    @Param('token') token: string,
    @Query('p') platformHint: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const now = new Date();
    const userAgent =
      typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent']
        : null;

    if (!this.campaigns.enabled) {
      this.sendGone(response, 'ردیابی کمپین در این نسخه فعال نیست.');

      return;
    }

    const result = await this.campaigns.recordClick({
      token: token.trim().toLowerCase(),
      platformHint: this.campaigns.parsePlatformHint(platformHint ?? null),
      userAgent,
      now,
    });

    // The token itself is never logged: only the decision and the classification.
    this.logger.debug(
      `Tracked link request → ${result.decision} (${result.classification}, recorded=${result.recorded}).`,
    );

    if (result.decision === 'NOT_FOUND') {
      this.sendNotFound(response);

      return;
    }

    if (result.decision === 'GONE' || !result.target) {
      // A token that is well formed but no longer accepts traffic: no target is offered at all, so a
      // paused campaign link can never keep working silently.
      if (!isTrackingToken(token.trim().toLowerCase())) {
        this.sendNotFound(response);
        return;
      }

      this.sendGone(response, result.reason);

      return;
    }

    response.status(302).set('Location', result.target).end();
  }

  private sendNotFound(response: Response): void {
    response
      .status(404)
      .type('html')
      .send(page('این لینک شناخته نشد.', 'نشانه ردیابی معتبر نیست.'));
  }

  private sendGone(response: Response, reason: string): void {
    response.status(410).type('html').send(page('این لینک فعال نیست.', reason));
  }
}

/** Minimal, self-contained HTML (no external assets, nothing that could leak a referrer). */
function page(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="fa" dir="rtl">',
    '<head><meta charset="utf-8"><meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="font-family:Tahoma,system-ui,sans-serif;padding:2rem;line-height:1.9">',
    `<h1 style="font-size:1.1rem">${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(body)}</p>`,
    '</body></html>',
  ].join('');
}
