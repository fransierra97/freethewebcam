import type { Db, Queryable } from '../db/index.ts';
import type { Market, Regions } from '../settings.ts';
import { PROVIDERS, manifest, type Category, type ProviderManifest } from './registry.ts';
import { decrypt, encrypt } from './secrets.ts';
import { PAYMENT_ADAPTERS, VERIFICATION_ADAPTERS } from './adapters/index.ts';
import type { AdapterEnv, CheckoutInput } from './adapters/types.ts';

export type ProviderState = 'disabled' | 'unconfigured' | 'test' | 'live';

export interface ProviderStatus {
  manifest: ProviderManifest;
  enabled: boolean;
  mode: 'test' | 'live';
  hasCredentials: boolean;
  state: ProviderState;
  usable: boolean;
}

interface Row {
  id: string;
  enabled: boolean;
  mode: 'test' | 'live';
  credentials_enc: string | null;
}

export class ProviderError extends Error {}

export class ProviderService {
  private db: Db;
  private appSecret: string;
  private publicUrl: string;
  /** Injectable in tests to simulate provider responses. */
  fetchFn: typeof fetch;
  constructor(db: Db, appSecret: string, publicUrl = '', fetchFn: typeof fetch = fetch) {
    this.db = db;
    this.appSecret = appSecret;
    this.publicUrl = publicUrl;
    this.fetchFn = fetchFn;
  }

  async list(): Promise<ProviderStatus[]> {
    const rows = await this.db.query<Row>('select id, enabled, mode, credentials_enc from provider_configs');
    const byId = new Map(rows.map((r) => [r.id, r]));
    return PROVIDERS.map((m) => this.toStatus(m, byId.get(m.id)));
  }

  async status(id: string): Promise<ProviderStatus | undefined> {
    const m = manifest(id);
    if (!m) return undefined;
    const row = await this.db.one<Row>('select id, enabled, mode, credentials_enc from provider_configs where id = $1', [id]);
    return this.toStatus(m, row);
  }

  private toStatus(m: ProviderManifest, row?: Row): ProviderStatus {
    const enabled = row?.enabled ?? false;
    const mode = row?.mode ?? 'test';
    const hasCredentials = Boolean(row?.credentials_enc);
    let state: ProviderState = 'disabled';
    if (enabled) state = mode === 'test' ? 'test' : hasCredentials ? 'live' : 'unconfigured';
    const usable = enabled && (mode === 'test' || (m.liveImplemented && hasCredentials));
    return { manifest: m, enabled, mode, hasCredentials, state, usable };
  }

  /**
   * First usable provider in the list for the requested category.
   * Always prefers one in live mode, so a provider left in test mode
   * cannot simulate verifications or payments when a live one is already configured.
   */
  async pick(ids: string[], category: Category): Promise<ProviderStatus | undefined> {
    const usable: ProviderStatus[] = [];
    for (const id of ids) {
      const s = await this.status(id);
      if (s && s.usable && s.manifest.categories.includes(category)) usable.push(s);
    }
    return usable.find((s) => s.mode === 'live') ?? usable[0];
  }

  async env(id: string): Promise<AdapterEnv> {
    return { publicUrl: this.publicUrl, creds: await this.credentials(id), fetch: this.fetchFn };
  }

  async credentials(id: string): Promise<Record<string, string>> {
    const row = await this.db.one<Row>('select credentials_enc from provider_configs where id = $1', [id]);
    return row?.credentials_enc ? decrypt(this.appSecret, row.credentials_enc) : {};
  }

  async saveCredentials(id: string, values: Record<string, string>): Promise<void> {
    const m = manifest(id);
    if (!m) throw new ProviderError('Unknown provider');
    const current = await this.credentials(id);
    const next: Record<string, string> = { ...current };
    for (const field of m.fields) {
      const v = (values[field.key] ?? '').trim();
      // An empty secret field means “leave unchanged”.
      if (v) next[field.key] = v;
      else if (!field.secret) delete next[field.key];
    }
    await this.upsert(id, { credentials_enc: encrypt(this.appSecret, next) });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!manifest(id)) throw new ProviderError('Unknown provider');
    await this.upsert(id, { enabled });
  }

  async setMode(id: string, mode: 'test' | 'live'): Promise<void> {
    const m = manifest(id);
    if (!m) throw new ProviderError('Unknown provider');
    if (mode === 'live') {
      if (!m.liveImplemented)
        throw new ProviderError(`The live integration with ${m.name} is not implemented yet; it stays in test mode.`);
      const creds = await this.credentials(id);
      const missing = m.fields.filter((f) => !f.optional && !creds[f.key]).map((f) => f.label);
      if (missing.length) throw new ProviderError(`Missing credentials: ${missing.join(', ')}`);
    }
    await this.upsert(id, { mode });
  }

  /** Checks the configuration. In test mode it always passes; in live mode it would call the provider. */
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const s = await this.status(id);
    if (!s) return { ok: false, message: 'Unknown provider' };
    if (!s.enabled) return { ok: false, message: 'It is disabled.' };
    if (s.mode === 'test') return { ok: true, message: 'Test mode: the built-in simulation will be used.' };
    if (!s.manifest.liveImplemented) return { ok: false, message: 'Live integration pending.' };
    const creds = await this.credentials(id);
    const missing = s.manifest.fields.filter((f) => !f.optional && !creds[f.key]).map((f) => f.label);
    if (missing.length) return { ok: false, message: `Missing credentials: ${missing.join(', ')}` };
    return {
      ok: true,
      message: `Credentials complete. In ${s.manifest.name}, set the notification URL ${this.publicUrl}/webhooks/${id} and run a test operation in its sandbox.`,
    };
  }

  /** Enables, in test mode, the providers used by the chosen markets. */
  async preconfigure(regions: Regions, markets: Market[], q: Queryable = this.db): Promise<void> {
    const wanted = new Set<string>(regions.creatorKycProviders);
    for (const market of [...markets, 'OTHER' as Market]) {
      const rule = regions.regions[market];
      rule.viewerAgeProviders.forEach((p) => wanted.add(p));
      rule.paymentProviders.forEach((p) => wanted.add(p));
    }
    for (const [, o] of Object.entries(regions.countryOverrides)) {
      o.viewerAgeProviders?.forEach((p) => wanted.add(p));
      o.paymentProviders?.forEach((p) => wanted.add(p));
    }
    for (const m of PROVIDERS) {
      await q.query(
        `insert into provider_configs (id, enabled, mode) values ($1, $2, 'test')
         on conflict (id) do update set enabled = excluded.enabled, updated_at = now()`,
        [m.id, wanted.has(m.id)],
      );
    }
  }

  private async upsert(id: string, patch: Partial<Row>): Promise<void> {
    await this.db.query(
      `insert into provider_configs (id, enabled, mode, credentials_enc)
       values ($1, coalesce($2, false), coalesce($3, 'test'), $4)
       on conflict (id) do update set
         enabled = coalesce($2, provider_configs.enabled),
         mode = coalesce($3, provider_configs.mode),
         credentials_enc = coalesce($4, provider_configs.credentials_enc),
         updated_at = now()`,
      [id, patch.enabled ?? null, patch.mode ?? null, patch.credentials_enc ?? null],
    );
  }

  /** Starts a payment. In test mode it redirects to the simulated gateway. */
  async startCheckout(id: string, input: CheckoutInput): Promise<{ redirectUrl: string; test: boolean }> {
    const s = await this.status(id);
    if (!s?.usable) throw new ProviderError('Payment provider not available');
    if (s.mode === 'test') return { redirectUrl: `/sandbox/pay/${input.purchaseId}`, test: true };
    const adapter = PAYMENT_ADAPTERS[id];
    if (!adapter) throw new ProviderError('Live integration pending');
    const { redirectUrl } = await adapter.checkout(await this.env(id), input);
    return { redirectUrl, test: false };
  }

  /** Starts a verification. In test mode it redirects to the simulated verification. */
  async startVerification(
    id: string,
    verificationId: number,
    purpose: 'creator_kyc' | 'viewer_age',
  ): Promise<{ redirectUrl: string; test: boolean; providerRef?: string }> {
    const s = await this.status(id);
    if (!s?.usable) throw new ProviderError('Verification provider not available');
    if (s.mode === 'test') return { redirectUrl: `/sandbox/verify/${verificationId}`, test: true };
    const adapter = VERIFICATION_ADAPTERS[id];
    if (!adapter) throw new ProviderError('Live integration pending');
    const { redirectUrl, providerRef } = await adapter.start(await this.env(id), {
      verificationId,
      purpose,
      returnUrl: `${this.publicUrl}/verify/return/${verificationId}`,
      webhookUrl: `${this.publicUrl}/webhooks/${id}`,
    });
    return { redirectUrl, test: false, providerRef };
  }
}
