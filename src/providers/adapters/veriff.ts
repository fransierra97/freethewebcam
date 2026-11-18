/**
 * Veriff: verification session + signed decision notification (HMAC-SHA256).
 * Docs: https://devdocs.veriff.com/apidocs/v1sessions · /docs/webhooks-guide
 *       /docs/hmac-authentication-and-endpoint-security
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { header, WebhookRejected, type Decision, type VerificationAdapter } from './types.ts';

export function veriffSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && timingSafeEqual(x, y);
}

export function veriffDecision(status: string): Decision {
  if (status === 'approved') return 'approved';
  if (['declined', 'expired', 'abandoned'].includes(status)) return 'rejected';
  return 'pending'; // resubmission_requested, review, created, started, submitted…
}

function base(creds: Record<string, string>): string {
  return (creds.baseUrl || 'https://stationapi.veriff.com').replace(/\/$/, '');
}

export const veriff: VerificationAdapter = {
  async start(env, input) {
    const res = await env.fetch(`${base(env.creds)}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-client': env.creds.apiKey },
      body: JSON.stringify({ verification: { callback: input.returnUrl, vendorData: String(input.verificationId) } }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.verification?.url) throw new Error(`Veriff did not create the session (${res.status})`);
    return { redirectUrl: data.verification.url, providerRef: String(data.verification.id) };
  },

  async fetchResult(env, providerRef) {
    const res = await env.fetch(`${base(env.creds)}/v1/sessions/${encodeURIComponent(providerRef)}/decision`, {
      headers: {
        'x-auth-client': env.creds.apiKey,
        'x-hmac-signature': veriffSignature(providerRef, env.creds.sharedSecret),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return 'pending';
    const data: any = await res.json().catch(() => ({}));
    return data?.verification ? veriffDecision(String(data.verification.status)) : 'pending';
  },

  async webhook(env, req) {
    const signature = header(req, 'x-hmac-signature');
    if (!signature || !sameHex(signature, veriffSignature(req.rawBody, env.creds.sharedSecret))) {
      throw new WebhookRejected('Invalid Veriff signature');
    }
    const v = req.body?.verification;
    if (!v) return {};
    const verificationId = Number(v.vendorData);
    return {
      verificationId: Number.isInteger(verificationId) ? verificationId : undefined,
      providerRef: v.id ? String(v.id) : undefined,
      decision: veriffDecision(String(v.status)),
    };
  },
};
