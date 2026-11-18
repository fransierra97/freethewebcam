import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Db, Queryable } from './db/index.ts';

export type Market = 'US' | 'EU' | 'LATAM' | 'OTHER';
export type AgeCheck = 'verify' | 'self_declare' | 'blocked';

export interface SiteSettings {
  name: string;
  mode: 'personal' | 'group';
  markets: Market[];
  setupComplete: boolean;
  /** Primary brand color (#rrggbb). */
  brandColor?: string;
  /**
   * Adults-only site: viewer age verification and 18+ notices.
   * If undefined, counts as “yes” (installs predating this setting).
   */
  ageRestricted?: boolean;
}

export function isAgeRestricted(site: SiteSettings): boolean {
  return site.ageRestricted !== false;
}

export interface TokenPackage {
  id: string;
  tokens: number;
  priceCents: number;
}

export interface Level {
  name: string;
  minSpent: number;
}

export interface Economy {
  currency: string;
  creatorSharePct: number;
  tokenValueCents: number;
  payoutMinTokens: number;
  tipMin: number;
  packages: TokenPackage[];
  levels: Level[];
}

export interface RegionRule {
  ageCheck: AgeCheck;
  viewerAgeProviders: string[];
  paymentProviders: string[];
}

export interface Regions {
  creatorKycProviders: string[];
  regions: Record<Market, RegionRule>;
  countryOverrides: Record<string, Partial<RegionRule>>;
}

/** Operator details for compliance and legal texts. */
export interface Compliance {
  /** Require complete, reviewed 2257 records before broadcasting. */
  require2257: boolean;
  operatorName: string;
  operatorAddress: string;
  contactEmail: string;
  custodianName: string;
  custodianTitle: string;
  /** Postal address where records are kept (a PO box is not valid). */
  custodianAddress: string;
  /** Days that incident-free moderation frames are kept. */
  frameRetentionDays: number;
  /** Seconds between moderation frames during a live stream (0 = disabled). */
  frameIntervalSeconds: number;
}

export const DEFAULT_COMPLIANCE: Compliance = {
  require2257: true,
  operatorName: '',
  operatorAddress: '',
  contactEmail: '',
  custodianName: '',
  custodianTitle: 'Custodian of Records',
  custodianAddress: '',
  frameRetentionDays: 7,
  frameIntervalSeconds: 60,
};

/** Broadcast options that depend on optional services (LiveKit Ingress / Egress). */
export interface MediaSettings {
  /** Record every public broadcast and private show (copy of the broadcast for 2257 records). */
  record: boolean;
  /** Generate HLS for viewers in “light mode” (more delay, scales better). */
  hls: boolean;
}

export const DEFAULT_MEDIA: MediaSettings = { record: true, hls: false };

export interface AllSettings {
  site: SiteSettings;
  media: MediaSettings;
  economy: Economy;
  regions: Regions;
  compliance: Compliance;
}

export function loadDefaults(): Omit<AllSettings, 'site' | 'compliance' | 'media'> {
  const raw = parse(readFileSync(join(import.meta.dirname, '..', 'config', 'defaults.yaml'), 'utf8'));
  return {
    economy: raw.economy,
    regions: {
      creatorKycProviders: raw.creatorKycProviders,
      regions: raw.regions,
      countryOverrides: raw.countryOverrides ?? {},
    },
  };
}

export const DEFAULT_SITE: SiteSettings = {
  name: 'FreeTheWebcam',
  mode: 'personal',
  markets: ['US', 'EU', 'LATAM'],
  setupComplete: false,
};

/** In-memory cache of settings; reloaded on save. */
export class SettingsStore {
  private cache: AllSettings | null = null;
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async get(): Promise<AllSettings> {
    if (this.cache) return this.cache;
    const rows = await this.db.query<{ key: string; value: any }>('select key, value from settings');
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const defaults = loadDefaults();
    this.cache = {
      site: { ...DEFAULT_SITE, ...(map.site ?? {}) },
      economy: map.economy ?? defaults.economy,
      regions: map.regions ?? defaults.regions,
      compliance: { ...DEFAULT_COMPLIANCE, ...(map.compliance ?? {}) },
      media: { ...DEFAULT_MEDIA, ...(map.media ?? {}) },
    };
    return this.cache;
  }

  async set<K extends keyof AllSettings>(key: K, value: AllSettings[K], q: Queryable = this.db): Promise<void> {
    await q.query(
      'insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
      [key, JSON.stringify(value)],
    );
    this.cache = null;
  }

  invalidate(): void {
    this.cache = null;
  }
}

export function levelFor(levels: Level[], spent: number): { current: Level; next: Level | null } {
  const sorted = [...levels].sort((a, b) => a.minSpent - b.minSpent);
  let current = sorted[0] ?? { name: '—', minSpent: 0 };
  let next: Level | null = null;
  for (const lvl of sorted) {
    if (spent >= lvl.minSpent) current = lvl;
    else {
      next = lvl;
      break;
    }
  }
  return { current, next };
}
