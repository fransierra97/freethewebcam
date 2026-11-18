import type { Market, Regions, RegionRule } from './settings.ts';

const EU = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ');
const LATAM = 'MX GT BZ SV HN NI CR PA CU DO HT CO VE EC PE BO BR PY UY AR CL'.split(' ');

export const MARKET_LABELS: Record<Market, string> = {
  US: 'United States',
  EU: 'European Union',
  LATAM: 'Latin America',
  OTHER: 'Rest of world and unknown country',
};

/**
 * Known legal minimums (not legal advice). Lowering a rule below this
 * requires explicit operator confirmation and is recorded in the audit log.
 */
export const LEGAL_NOTES: Record<string, string> = {
  US: 'Between 24 and 27 states require age verification (FSC v. Paxton, 2025).',
  EU: 'DSA Art. 28 guidelines: verification (not estimation) for age-restricted content. France (ARCOM) requires double anonymity.',
  BR: 'ECA Digital (Law 15.211/2025): bans self-declaration and requires hiding previews until verified.',
  FR: 'ARCOM: mandatory verification with at least one double-anonymity option.',
};

export function marketFor(country: string): Market {
  if (!country) return 'OTHER';
  if (country === 'US') return 'US';
  if (EU.includes(country)) return 'EU';
  if (LATAM.includes(country)) return 'LATAM';
  return 'OTHER';
}

export function ruleFor(regions: Regions, country: string): RegionRule & { market: Market } {
  const market = marketFor(country);
  const base = regions.regions[market];
  const override = country ? regions.countryOverrides[country] : undefined;
  return { market, ...base, ...(override ?? {}) };
}

const STRICTNESS: Record<string, number> = { blocked: 2, verify: 1, self_declare: 0 };

export function isLowering(from: string, to: string): boolean {
  return (STRICTNESS[to] ?? 0) < (STRICTNESS[from] ?? 0);
}
