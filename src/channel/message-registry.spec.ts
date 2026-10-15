import {
  allSpecs,
  assertMessageType,
  editorialSpecs,
  isEditorialType,
  PILLAR_TITLES,
  scheduledMarketSpecs,
  seriesTitleOf,
  specFor,
} from './message-registry';
import { MessageType } from './channel.types';

/**
 * §27.1 — registry: exactly seven typed message types, one specification per type, invalid types
 * rejected at runtime, and the three content pillars carry their official titles.
 */

const SEVEN_TYPES: MessageType[] = [
  'PRICE_UPDATE',
  'MARKET_MOVEMENT',
  'DAILY_RANGE',
  'DAILY_REPORT',
  'EDUCATIONAL',
  'BRANDED',
  'NIGHTLY_ANALYSIS',
];

describe('message registry (§27.1)', () => {
  it('registers exactly the seven specified message types', () => {
    expect(
      allSpecs()
        .map((spec) => spec.type)
        .sort(),
    ).toEqual([...SEVEN_TYPES].sort());
    expect(allSpecs()).toHaveLength(7);
  });

  it('every type maps to exactly one specification', () => {
    for (const type of SEVEN_TYPES) {
      const spec = specFor(type);

      expect(spec.type).toBe(type);
      expect(spec.labelFa.length).toBeGreaterThan(0);
    }
  });

  it('separates market types from editorial types', () => {
    const market = allSpecs().filter((spec) => spec.kind === 'MARKET');
    const editorial = allSpecs().filter((spec) => spec.kind === 'EDITORIAL');

    expect(market.map((spec) => spec.type)).toEqual([
      'PRICE_UPDATE',
      'MARKET_MOVEMENT',
      'DAILY_RANGE',
      'DAILY_REPORT',
    ]);
    expect(editorial.map((spec) => spec.type).sort()).toEqual([
      'BRANDED',
      'EDUCATIONAL',
      'NIGHTLY_ANALYSIS',
    ]);
  });

  it('requires approval for every editorial type and for none of the market types', () => {
    for (const spec of allSpecs()) {
      expect(spec.requiresApproval).toBe(spec.kind === 'EDITORIAL');
      expect(spec.marketDerived).toBe(spec.kind === 'MARKET');
    }
  });

  it('keeps the three official pillar titles', () => {
    expect(PILLAR_TITLES).toEqual({
      EDUCATIONAL: 'گنجینه طلایی اتابک',
      BRANDED: 'طلای اتابک',
      NIGHTLY_ANALYSIS: 'نگاه طلای اتابک',
    });

    for (const spec of editorialSpecs()) {
      expect(spec.seriesTitle).toBe(PILLAR_TITLES[spec.type]);
      expect(seriesTitleOf(spec.type)).toBe(PILLAR_TITLES[spec.type]);
    }
  });

  it('shows no series title for market-derived messages', () => {
    for (const type of SEVEN_TYPES.filter(
      (candidate) => !isEditorialType(candidate),
    )) {
      expect(seriesTitleOf(type)).toBeNull();
    }
  });

  it('lists the market types the engine schedules itself', () => {
    expect(scheduledMarketSpecs().map((spec) => spec.type)).toEqual([
      'PRICE_UPDATE',
      'DAILY_RANGE',
      'DAILY_REPORT',
    ]);
  });

  it('rejects an unknown type at runtime instead of rendering something', () => {
    expect(() => assertMessageType('NEWSLETTER')).toThrow(
      /Unknown message type/,
    );
    expect(() => assertMessageType(undefined)).toThrow(/Unknown message type/);
    expect(() => assertMessageType(42)).toThrow(/Unknown message type/);
    expect(() => assertMessageType('PRICE_UPDATE')).not.toThrow();
  });

  it('gives editorial types a body budget and market types none', () => {
    for (const spec of allSpecs()) {
      if (spec.kind === 'EDITORIAL') {
        expect(spec.maxBodyChars).toBeGreaterThan(0);
      } else {
        expect(spec.maxBodyChars).toBe(0);
      }
    }
  });

  it('recognizes only the three editorial types', () => {
    expect(SEVEN_TYPES.filter(isEditorialType)).toEqual([
      'EDUCATIONAL',
      'BRANDED',
      'NIGHTLY_ANALYSIS',
    ]);
  });
});
