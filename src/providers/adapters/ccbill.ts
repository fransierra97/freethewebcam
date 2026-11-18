/**
 * CCBill FlexForms with dynamic pricing and webhooks.
 * Docs: https://ccbill.com/doc/dynamic-pricing-flexforms · https://ccbill.com/doc/formdigest-value
 *       https://ccbill.com/doc/webhooks-user-guide · https://ccbill.com/doc/newsalesuccess
 * CCBill webhooks are not signed: they are checked by IP (ranges published by CCBill),
 * by account/sub-account and by amount.
 */
import { createHash } from 'node:crypto';
import { WebhookRejected, toAmount, type AdapterEnv, type PaymentAdapter, type PaymentEvent, type WebhookRequest } from './types.ts';

/** Numeric currency codes listed in the CCBill documentation. */
export const CCBILL_CURRENCIES: Record<string, string> = { USD: '840', EUR: '978', GBP: '826', CAD: '124', AUD: '036', JPY: '392' };

/** IP ranges of the CCBill webhooks (64.38.212/215/240/241.1–254). */
const ALLOWED_PREFIXES = ['64.38.212.', '64.38.215.', '64.38.240.', '64.38.241.'];

/** Initial period in days; it has no practical effect on a one-time token purchase. */
const INITIAL_PERIOD = '30';

export function ccbillDigest(price: string, period: string, currencyCode: string, salt: string): string {
  return createHash('md5').update(`${price}${period}${currencyCode}${salt}`).digest('hex');
}

export function ccbillIpAllowed(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  if (!ALLOWED_PREFIXES.some((p) => v4.startsWith(p))) return false;
  const last = Number(v4.split('.')[3]);
  return last >= 1 && last <= 254;
}

function field(body: any, ...names: string[]): string {
  for (const n of names) {
    const v = body?.[n];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
}

export const ccbill: PaymentAdapter = {
  async checkout(env, input) {
    const { clientSubacc, flexFormId, salt } = env.creds;
    const currencyCode = CCBILL_CURRENCIES[input.currency];
    if (!currencyCode) throw new Error(`CCBill does not support the currency ${input.currency}`);
    const price = toAmount(input.priceCents);
    const params = new URLSearchParams({
      clientSubacc,
      initialPrice: price,
      initialPeriod: INITIAL_PERIOD,
      currencyCode,
      formDigest: ccbillDigest(price, INITIAL_PERIOD, currencyCode, salt),
      // Pass-through value: CCBill returns it in the webhook (the documentation requires the X- prefix).
      'X-ftw_purchase': String(input.purchaseId),
    });
    return { redirectUrl: `https://api.ccbill.com/wap-frontflex/flexforms/${encodeURIComponent(flexFormId)}?${params}` };
  },

  async webhook(env, req) {
    if (!ccbillIpAllowed(req.ip)) throw new WebhookRejected(`IP not authorized: ${req.ip}`);
    const body = req.body ?? {};
    const eventType = req.query.eventType || field(body, 'eventType');
    if (field(body, 'clientAccnum') && env.creds.clientAccnum && field(body, 'clientAccnum') !== env.creds.clientAccnum) {
      throw new WebhookRejected('CCBill account mismatch');
    }
    if (field(body, 'clientSubacc') && env.creds.clientSubacc && field(body, 'clientSubacc') !== env.creds.clientSubacc) {
      throw new WebhookRejected('CCBill sub-account mismatch');
    }
    const purchaseId = Number(field(body, 'X-ftw_purchase', 'x-ftw_purchase', 'ftw_purchase', 'X-FTW_PURCHASE'));
    if (!Number.isInteger(purchaseId) || purchaseId <= 0) return { events: [] };
    const providerRef = field(body, 'transactionId', 'subscriptionId');
    let event: PaymentEvent | null = null;
    switch (eventType) {
      case 'NewSaleSuccess': {
        const amount = field(body, 'subscriptionInitialPrice', 'billedInitialPrice', 'accountingInitialPrice');
        event = {
          purchaseId,
          kind: 'paid',
          providerRef,
          amountCents: amount ? Math.round(Number(amount) * 100) : undefined,
        };
        break;
      }
      case 'NewSaleFailure':
        event = { purchaseId, kind: 'failed', providerRef, reason: field(body, 'failureReason') };
        break;
      case 'Refund':
      case 'Return':
        event = { purchaseId, kind: 'reversed', providerRef, reason: 'refund' };
        break;
      case 'Chargeback':
        event = { purchaseId, kind: 'reversed', providerRef, reason: 'chargeback' };
        break;
      case 'Void':
        event = { purchaseId, kind: 'reversed', providerRef, reason: 'void' };
        break;
    }
    return { events: event ? [event] : [] };
  },
};

export type { AdapterEnv, WebhookRequest };
