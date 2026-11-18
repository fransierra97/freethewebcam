/**
 * Vendo: signed custom offer link + postbacks.
 * Docs: https://docs.vendoservices.com/docs/custom-offer-link.md · /docs/signing-urls.md
 *       /docs/vservices-postbacks · /docs/postback-security · /docs/pix.md · /docs/oxxo.md
 * Postbacks are not signed: they are checked against Vendo's public IP list and the amount.
 */
import { createHmac } from 'node:crypto';
import { WebhookRejected, toAmount, type PaymentAdapter, type PaymentEvent } from './types.ts';

const BASE = 'https://secure.vend-o.com';
const IP_LIST_URL = `${BASE}/api/postback-ip-list`;
const IP_CACHE_MS = 60 * 60 * 1000;
let ipCache: { ips: string[]; at: number } | null = null;

/** Vendo signature: HMAC-SHA1 of path+query with the shared secret, in URL-safe Base64 without “=”. */
export function vendoSign(pathAndQuery: string, secret: string): string {
  return createHmac('sha1', secret).update(pathAndQuery).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function vendoIps(fetchFn: typeof fetch): Promise<string[]> {
  if (ipCache && Date.now() - ipCache.at < IP_CACHE_MS) return ipCache.ips;
  const res = await fetchFn(IP_LIST_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Vendo: could not read the IP list (${res.status})`);
  // Observed format: IPs separated by “|”.
  const ips = (await res.text()).split(/[|,\s]+/).map((s) => s.trim()).filter(Boolean);
  ipCache = { ips, at: Date.now() };
  return ips;
}

export function resetVendoIpCache(): void {
  ipCache = null;
}

const POSTBACK_OK = '<postbackResponse><transaction><code>1</code></transaction></postbackResponse>';

export const vendo: PaymentAdapter = {
  async checkout(env, input) {
    const { siteId, sharedSecret } = env.creds;
    if (!['USD', 'EUR', 'GBP'].includes(input.currency)) throw new Error(`Vendo does not support the currency ${input.currency}`);
    const params = new URLSearchParams({
      site: siteId,
      type: 'normal',
      billing_schedule_type: 'token',
      token_amount: toAmount(input.priceCents),
      token_quantity: String(input.tokens),
      billing_currency: input.currency,
      ref: String(input.purchaseId),
    });
    const path = `/v/custom-offer?${params}`;
    return { redirectUrl: `${BASE}${path}&signature=${vendoSign(path, sharedSecret)}` };
  },

  async webhook(env, req) {
    const ips = await vendoIps(env.fetch);
    const ip = req.ip.replace(/^::ffff:/, '');
    if (!ips.includes(ip)) throw new WebhookRejected(`IP not authorized: ${ip}`);
    const b = req.body ?? {};
    const reply = { status: 200, contentType: 'text/xml', body: POSTBACK_OK };
    if (b.callback !== 'transaction') return { events: [], reply };
    const purchaseId = Number(b.merchant_reference);
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) return { events: [], reply };
    const providerRef = String(b.transaction_id ?? '');
    const status = String(b.transaction_status ?? '');
    let event: PaymentEvent | null = null;
    if (status === '1') {
      event = {
        purchaseId,
        kind: 'paid',
        providerRef,
        amountCents: b.invoice_amount ? Math.round(Number(b.invoice_amount) * 100) : undefined,
        currency: b.invoice_currency ? String(b.invoice_currency) : undefined,
      };
    } else if (status === '9') {
      event = { purchaseId, kind: 'reversed', providerRef, reason: 'chargeback' };
    }
    return { events: event ? [event] : [], reply };
  },
};
