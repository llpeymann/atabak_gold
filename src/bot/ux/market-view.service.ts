import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { MarketStateService } from '../../market/market-state.service';
import { MarketSection, SymbolMarketState } from '../../market/market.types';
import { SECTION_NAMES, SymbolDefinition } from '../../market/symbols';
import { UserService } from '../../users/user.service';
import {
  FavoritesManageView,
  MarketSnapshotLineView,
  MarketSnapshotView,
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

  /** Daily snapshot (open/high/low/current/change) for the anchor symbols. */
  buildMarketSnapshot(now = new Date()): MarketSnapshotView {
    const definitions = this.config.symbolRegistry.filter(
      (definition) => definition.required,
    );

    const lines: MarketSnapshotLineView[] = [];

    for (const definition of definitions) {
      const state = this.marketState.getState(definition, now);

      // Only instruments with a real (validated) daily window are shown — nothing is invented.
      if (!state?.daily) {
        continue;
      }

      lines.push({
        symbol: state.symbol,
        label: state.label,
        section: state.section,
        unit: state.unit,
        open: state.daily.open,
        high: state.daily.high,
        low: state.daily.low,
        current: state.daily.current,
        change: state.daily.change,
        freshness: state.freshness,
        updatedAt: state.updatedAt,
      });
    }

    return {
      lines,
      lastUpdate: this.newestUpdate(lines.map((line) => line.updatedAt)),
      hasStale: lines.some((line) => line.freshness === 'STALE'),
    };
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
