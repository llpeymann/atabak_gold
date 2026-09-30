import { MarketSection, PriceUnit } from './market.types';

/**
 * THE single source of truth for supported symbols.
 *
 * Every symbol the application knows about is declared exactly once, together with:
 *  - where it belongs in the published message (`section`, `label`, `order`),
 *  - whether its absence must be reported as a hard requirement (`required`),
 *  - the canonical internal unit,
 *  - and the sanity thresholds used by the anomaly engine.
 *
 * Threshold documentation (Phase 1 requirement, see docs/PHASE_1_REPORT.md §6):
 *  - `minPrice`/`maxPrice` are *guardrails* that catch corrupt values (0, 1, 10^12, a value from the
 *    wrong column of the upstream feed), not market predictions. They are intentionally wide.
 *  - `maxChangePercent` is the maximum plausible move between two consecutive updates (~30 minutes)
 *    for that instrument in the Iranian market. A single update moving further than this is treated
 *    as a data anomaly (`EXCESSIVE_CHANGE`) and is not published.
 *  - `maxAbsoluteChange` is an optional second guard for instruments where a percentage alone can
 *    hide a large absolute jump.
 */
export interface SymbolDefinition {
  symbol: string;
  label: string;
  section: MarketSection;
  /** Order inside its section (matches the published message layout). */
  order: number;
  /** Required symbols are the anchors of a section: their absence is reported as MISSING_SYMBOL. */
  required: boolean;
  /** Canonical internal unit of the value. */
  unit: PriceUnit;
  /** Lower sanity bound in the canonical unit (`null` = no lower bound). */
  minPrice: number | null;
  /** Upper sanity bound in the canonical unit (`null` = no upper bound). */
  maxPrice: number | null;
  /**
   * Maximum plausible percentage move between two consecutive updates. `null` means "no
   * tolerance documented for this symbol yet": the configured `PRICE_MAX_CHANGE_PERCENT`
   * fallback applies (see `buildSymbolRegistry`). Every symbol below documents a value.
   */
  maxChangePercent: number | null;
  /** Optional absolute move guard, in the canonical unit. */
  maxAbsoluteChange: number | null;
  /** Why the thresholds above were chosen (documented per symbol). */
  rationale: string;
}

const RIAL = 'RIAL' as const;
const USD = 'USD' as const;

/** Default change threshold applied to symbols without a specific override. */
export const DEFAULT_MAX_CHANGE_PERCENT = 8;

const GOLD_RATIONALE =
  'Domestic bullion prices can gap on FX/news moves, but a >10% move inside one 30-minute ' +
  'update window is an upstream data error in practice.';
const COIN_RATIONALE =
  'Coins carry a speculative premium and are more volatile than bullion, so a wider 12% window ' +
  'is allowed before a single update is considered anomalous.';
const FX_RATIONALE =
  'The Iranian FX market is managed and moves in small steps; a >8% step between two updates ' +
  'normally means a malformed feed value rather than a real market move.';
const XAU_RATIONALE =
  'The global gold spot price is the least volatile instrument here; intraday moves above 5% are ' +
  'rare, so a wider move indicates a corrupt value.';

/**
 * Symbol registry. `order` mirrors the previous hard-coded layout of the published message
 * so the user-facing output keeps its existing structure.
 */
export const SYMBOL_DEFINITIONS: readonly SymbolDefinition[] = [
  {
    symbol: 'XAUUSD',
    label: 'اونس جهانی',
    section: 'gold',
    order: 1,
    required: false,
    unit: USD,
    minPrice: 500,
    maxPrice: 20_000,
    maxChangePercent: 5,
    maxAbsoluteChange: 300,
    rationale: XAU_RATIONALE,
  },
  {
    symbol: 'IR_GOLD_18K',
    label: 'طلای ۱۸ عیار',
    section: 'gold',
    order: 2,
    required: true,
    unit: RIAL,
    minPrice: 1_000_000,
    maxPrice: 1_000_000_000,
    maxChangePercent: 10,
    maxAbsoluteChange: null,
    rationale: GOLD_RATIONALE,
  },
  {
    symbol: 'IR_GOLD_24K',
    label: 'طلای ۲۴ عیار',
    section: 'gold',
    order: 3,
    required: false,
    unit: RIAL,
    minPrice: 1_000_000,
    maxPrice: 1_500_000_000,
    maxChangePercent: 10,
    maxAbsoluteChange: null,
    rationale: GOLD_RATIONALE,
  },
  {
    symbol: 'IR_GOLD_MELTED',
    label: 'آبشده نقدی',
    section: 'gold',
    order: 4,
    required: false,
    unit: RIAL,
    minPrice: 500_000,
    maxPrice: 1_000_000_000,
    maxChangePercent: 10,
    maxAbsoluteChange: null,
    rationale: GOLD_RATIONALE,
  },
  {
    symbol: 'IR_COIN_EMAMI',
    label: 'سکه امامی',
    section: 'coins',
    order: 1,
    required: true,
    unit: RIAL,
    minPrice: 20_000_000,
    maxPrice: 100_000_000_000,
    maxChangePercent: 12,
    maxAbsoluteChange: null,
    rationale: COIN_RATIONALE,
  },
  {
    symbol: 'IR_COIN_BAHAR',
    label: 'سکه تمام بهار',
    section: 'coins',
    order: 2,
    required: false,
    unit: RIAL,
    minPrice: 20_000_000,
    maxPrice: 100_000_000_000,
    maxChangePercent: 12,
    maxAbsoluteChange: null,
    rationale: COIN_RATIONALE,
  },
  {
    symbol: 'IR_COIN_HALF',
    label: 'نیم سکه',
    section: 'coins',
    order: 3,
    required: false,
    unit: RIAL,
    minPrice: 10_000_000,
    maxPrice: 50_000_000_000,
    maxChangePercent: 12,
    maxAbsoluteChange: null,
    rationale: COIN_RATIONALE,
  },
  {
    symbol: 'IR_COIN_QUARTER',
    label: 'ربع سکه',
    section: 'coins',
    order: 4,
    required: false,
    unit: RIAL,
    minPrice: 5_000_000,
    maxPrice: 30_000_000_000,
    maxChangePercent: 12,
    maxAbsoluteChange: null,
    rationale: COIN_RATIONALE,
  },
  {
    symbol: 'IR_COIN_1G',
    label: 'سکه گرمی',
    section: 'coins',
    order: 5,
    required: false,
    unit: RIAL,
    minPrice: 1_000_000,
    maxPrice: 10_000_000_000,
    maxChangePercent: 12,
    maxAbsoluteChange: null,
    rationale: COIN_RATIONALE,
  },
  {
    symbol: 'USDT_IRT',
    label: 'تتر (فی)',
    section: 'currency',
    order: 1,
    required: false,
    unit: RIAL,
    minPrice: 1_000,
    maxPrice: 100_000_000,
    maxChangePercent: 8,
    maxAbsoluteChange: null,
    rationale: FX_RATIONALE,
  },
  {
    symbol: 'USD',
    label: '🇺🇸 دلار آمریکا',
    section: 'currency',
    order: 2,
    required: true,
    unit: RIAL,
    minPrice: 10_000,
    maxPrice: 100_000_000,
    maxChangePercent: 8,
    maxAbsoluteChange: null,
    rationale: FX_RATIONALE,
  },
  {
    symbol: 'EUR',
    label: '🇪🇺 یورو',
    section: 'currency',
    order: 3,
    required: false,
    unit: RIAL,
    minPrice: 10_000,
    maxPrice: 100_000_000,
    maxChangePercent: 8,
    maxAbsoluteChange: null,
    rationale: FX_RATIONALE,
  },
  {
    symbol: 'GBP',
    label: '🇬🇧 پوند',
    section: 'currency',
    order: 4,
    required: false,
    unit: RIAL,
    minPrice: 10_000,
    maxPrice: 100_000_000,
    maxChangePercent: 8,
    maxAbsoluteChange: null,
    rationale: FX_RATIONALE,
  },
  {
    symbol: 'TRY',
    label: '🇹🇷 لیر ترکیه',
    section: 'currency',
    order: 5,
    required: false,
    unit: RIAL,
    minPrice: 100,
    maxPrice: 10_000_000,
    maxChangePercent: 10,
    maxAbsoluteChange: null,
    rationale:
      'TRY has structurally higher volatility than the other quoted currencies, so its single-step ' +
      'tolerance is raised to 10%.',
  },
  {
    symbol: 'AED',
    label: '🇦🇪 درهم امارات',
    section: 'currency',
    order: 6,
    required: false,
    unit: RIAL,
    minPrice: 1_000,
    maxPrice: 100_000_000,
    maxChangePercent: 8,
    maxAbsoluteChange: null,
    rationale: FX_RATIONALE,
  },
  {
    symbol: 'CNY',
    label: '🇨🇳 یوآن چین',
    section: 'currency',
    order: 7,
    required: false,
    unit: RIAL,
    minPrice: 1_000,
    maxPrice: 100_000_000,
    maxChangePercent: 8,
    maxAbsoluteChange: null,
    rationale: FX_RATIONALE,
  },
];

export const SECTION_TITLES: Record<MarketSection, string> = {
  gold: '🟨 <b>طلا</b>',
  coins: '🪙 <b>سکه</b>',
  currency: '💰 <b>بازار ارز</b>',
};

export const SECTION_ORDER: readonly MarketSection[] = [
  'gold',
  'coins',
  'currency',
];

/** Runtime threshold overrides coming from the environment. */
export interface ThresholdOverrides {
  /**
   * Fallback tolerance, used **only** for symbols that do not document a specific
   * tolerance themselves. It never lowers a documented per-symbol threshold: the
   * documented value stays authoritative unless an operator explicitly overrides it.
   */
  defaultMaxChangePercent?: number;
  /** Per-symbol percentage overrides, e.g. `{ XAUUSD: 10 }`. */
  maxChangePercentBySymbol?: Readonly<Record<string, number>>;
}

export function buildSymbolRegistry(
  overrides: ThresholdOverrides = {},
  definitions: readonly SymbolDefinition[] = SYMBOL_DEFINITIONS,
): readonly SymbolDefinition[] {
  const { defaultMaxChangePercent, maxChangePercentBySymbol } = overrides;
  const fallback = isValidThreshold(defaultMaxChangePercent)
    ? defaultMaxChangePercent
    : undefined;

  return definitions.map((definition) => {
    const explicitOverride = maxChangePercentBySymbol?.[definition.symbol];

    if (isValidThreshold(explicitOverride)) {
      return { ...definition, maxChangePercent: explicitOverride };
    }

    if (definition.maxChangePercent !== null) {
      // The symbol documents its own tolerance — it stays authoritative.
      return definition;
    }

    return { ...definition, maxChangePercent: fallback ?? null };
  });
}

function isValidThreshold(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

export function symbolsBySection(
  registry: readonly SymbolDefinition[],
  section: MarketSection,
): SymbolDefinition[] {
  return registry
    .filter((definition) => definition.section === section)
    .sort((a, b) => a.order - b.order);
}
