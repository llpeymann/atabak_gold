import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import {
  MarketIntelligenceSnapshot,
  MarketSymbolSnapshot,
} from '../../intelligence/market-intelligence.types';
import { MarketIntelligenceService } from '../../intelligence/market-intelligence.service';
import { MarketStateService } from '../../market/market-state.service';
import { MarketSection, SymbolMarketState } from '../../market/market.types';
import { SECTION_NAMES, SymbolDefinition } from '../../market/symbols';
import { UserService } from '../../users/user.service';
import {
  FavoritesManageView,
  PriceListView,
  PriceSectionView,
  PriceView,
} from './ux-view.types';

/**
 * Read-only projection of the Phase 1 market state into view models.
 *
 * This service is the *only* market dependency of the bot UX. It has no access to `PriceService`
 * and no way to mutate market state, which makes it structurally impossible for a user
 * interaction to trigger an external API call or to alter validated prices (§3, §11, §12, §51).
 */
@Injectable()
export class MarketViewService {
  constructor(
    private readonly config: AppConfigService,
    private readonly marketState: MarketStateService,
    private readonly intelligence: MarketIntelligenceService,
    private readonly users: UserService,
  ) {}

  /**
   * Registry entries for a set of sections, in registry order.
   * The registry is already stored in publication order (gold → coins → currency), so no local
   * ordering rule is introduced here (§14).
   */
  private definitions(sections: readonly MarketSection[]): SymbolDefinition[] {
    return this.config.symbolRegistry.filter((definition) =>
      sections.includes(definition.section),
    );
  }

  buildPriceList(
    sections: readonly MarketSection[],
    now = new Date(),
  ): PriceListView {
    const definitions = this.definitions(sections);
    const items = definitions
      .map((definition) => this.toPriceView(definition, now))
      .filter((view): view is PriceView => view !== null);

    const grouped: PriceSectionView[] = [];
    for (const definition of definitions) {
      const item = items.find((view) => view.symbol === definition.symbol);
      if (!item) {
        continue;
      }

      const existing = grouped.find(
        (entry) => entry.section === definition.section,
      );

      if (existing) {
        existing.items.push(item);
      } else {
        grouped.push({
          section: definition.section,
          title: SECTION_NAMES[definition.section],
          items: [item],
        });
      }
    }

    return {
      sections: grouped,
      lastUpdate: this.newestUpdate(items.map((item) => item.updatedAt)),
      hasStale: items.some((item) => item.freshness === 'STALE'),
      missing: definitions
        .filter(
          (definition) =>
            !items.some((item) => item.symbol === definition.symbol),
        )
        .map((definition) => definition.label),
    };
  }

  /** Prices for an explicit symbol list (used by favorites — order follows the registry). */
  buildPriceListForSymbols(
    symbols: readonly string[],
    now = new Date(),
  ): PriceListView {
    const wanted = new Set(symbols);
    const definitions = this.config.symbolRegistry.filter((definition) =>
      wanted.has(definition.symbol),
    );

    const items = definitions
      .map((definition) => this.toPriceView(definition, now))
      .filter((view): view is PriceView => view !== null);

    const grouped: PriceSectionView[] = [];
    for (const item of items) {
      const existing = grouped.find((entry) => entry.section === item.section);

      if (existing) {
        existing.items.push(item);
      } else {
        grouped.push({
          section: item.section,
          title: SECTION_NAMES[item.section],
          items: [item],
        });
      }
    }

    return {
      sections: grouped,
      lastUpdate: this.newestUpdate(items.map((item) => item.updatedAt)),
      hasStale: items.some((item) => item.freshness === 'STALE'),
      missing: definitions
        .filter(
          (definition) =>
            !items.some((item) => item.symbol === definition.symbol),
        )
        .map((definition) => definition.label),
    };
  }

  /**
   * Phase 4 — the complete market intelligence snapshot (`📊 بازار`).
   *
   * One read pass over the validated Phase 1 state; nothing is fetched, recalculated from raw
   * payloads or mutated here (§15, §42, §43). Rending this again is exactly what the
   * `🔄 بروزرسانی` button does.
   */
  buildIntelligence(now = new Date()): MarketIntelligenceSnapshot {
    return this.intelligence.build(now);
  }

  /**
   * Single-symbol projection for screens that focus on one instrument (the favourites list).
   * Same read-only snapshot builder, no separate calculation path.
   */
  buildSymbolIntelligence(
    symbol: string,
    now = new Date(),
  ): MarketSymbolSnapshot | null {
    return this.intelligence.buildFor(symbol, now);
  }

  /** Favorite management options (all supported symbols, marked with the user's selection). */
  buildFavoritesManage(userId: string): FavoritesManageView {
    const selected = new Set(this.users.listFavoriteSymbols(userId));
    const limit = this.users.maxFavorites;

    return {
      options: this.config.symbolRegistry.map((definition) => ({
        symbol: definition.symbol,
        label: definition.label,
        section: definition.section,
        selected: selected.has(definition.symbol),
      })),
      limit,
      selectedCount: selected.size,
      limitReached: selected.size >= limit,
    };
  }

  private toPriceView(
    definition: SymbolDefinition,
    now: Date,
  ): PriceView | null {
    const state = this.marketState.getState(definition, now);

    // A symbol without any validated price yet is simply absent (the formatter shows the
    // section's empty state). Nothing is fabricated.
    return state ? this.fromState(state) : null;
  }

  private fromState(state: SymbolMarketState): PriceView {
    return {
      symbol: state.symbol,
      label: state.label,
      section: state.section,
      price: state.currentPrice,
      unit: state.unit,
      percentageChange: state.percentageChange,
      direction: state.direction,
      freshness: state.freshness,
      updatedAt: state.updatedAt,
    };
  }

  private newestUpdate(timestamps: readonly string[]): string | null {
    if (timestamps.length === 0) {
      return null;
    }

    return timestamps.reduce((newest, current) =>
      current > newest ? current : newest,
    );
  }
}
