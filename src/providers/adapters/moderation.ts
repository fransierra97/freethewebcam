/**
 * Illegal content detectors for live stream frames.
 * - Hive CSAM Detection (combinado): https://docs.thehive.ai/reference/csam-detection-combined-api-reference
 * - Signed generic connector, to plug in PhotoDNA, Thorn Safer or another service of your own.
 */
import { createHmac } from 'node:crypto';
import type { AdapterEnv } from './types.ts';

export type Verdict = 'clear' | 'suspect' | 'match';

export interface ScanResult {
  verdict: Verdict;
  detail: string;
}

export interface ModerationScanner {
  scan(env: AdapterEnv, image: Buffer, mime?: string): Promise<ScanResult>;
}

/** Interprets the Hive response (path status[].response.output). */
export function hiveVerdict(body: any, threshold: number): ScanResult {
  const outputs: any[] = (body?.status ?? []).map((s: any) => s?.response?.output).filter(Boolean);
  for (const out of outputs) {
    const list = Array.isArray(out) ? out : [out];
    for (const o of list) {
      // Results from Thorn's test set (“test”) are ignored, as Hive instructs.
      const hashes = (o?.hashes ?? []).filter((h: any) => !(h?.sources ?? []).every((s: any) => s?.hashSet === 'test'));
      if (hashes.length) {
        return { verdict: 'match', detail: `Hash match: ${JSON.stringify(hashes.map((h: any) => ({ type: h.hashType, match: h.matchTypes })))}` };
      }
      const score = Number(o?.file?.classifierPrediction?.csam_classifier?.csam ?? 0);
      if (score >= threshold) return { verdict: 'suspect', detail: `Classifier: csam=${score.toFixed(3)}` };
    }
  }
  return { verdict: 'clear', detail: '' };
}

export const hiveCsam: ModerationScanner = {
  async scan(env, jpeg, mime = 'image/jpeg') {
    const form = new FormData();
    form.append('media', new Blob([new Uint8Array(jpeg)], { type: mime }), `image.${mime.split('/')[1] ?? 'jpg'}`);
    const res = await env.fetch('https://api.thehive.ai/api/v2/task/sync', {
      method: 'POST',
      headers: { authorization: `Token ${env.creds.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Hive responded ${res.status}`);
    return hiveVerdict(await res.json(), Number(env.creds.classifierThreshold || 0.9));
  },
};

export function webhookSignature(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export const moderationWebhook: ModerationScanner = {
  async scan(env, jpeg, mime = 'image/jpeg') {
    if (!/^https:\/\//.test(env.creds.url ?? '')) throw new Error('The detector URL must be HTTPS');
    const res = await env.fetch(env.creds.url, {
      method: 'POST',
      headers: { 'content-type': mime, 'x-ftw-signature': webhookSignature(jpeg, env.creds.secret) },
      body: new Uint8Array(jpeg),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`The detector responded ${res.status}`);
    const data: any = await res.json();
    const verdict: Verdict = ['clear', 'suspect', 'match'].includes(data?.verdict) ? data.verdict : 'suspect';
    return { verdict, detail: String(data?.detail ?? '').slice(0, 500) };
  },
};

export const MODERATION_SCANNERS: Record<string, ModerationScanner> = { hive_csam: hiveCsam, moderation_webhook: moderationWebhook };
export const MODERATION_ORDER = ['hive_csam', 'moderation_webhook'];
