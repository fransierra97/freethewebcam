/** Common contracts for the live provider adapters. */

export interface AdapterEnv {
  publicUrl: string;
  creds: Record<string, string>;
  fetch: typeof fetch;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  body: any;
  query: Record<string, string>;
  ip: string;
  /** Part of the path after /webhooks/:provider/ (e.g. “idv/12”). */
  subpath: string;
}

export interface WebhookReply {
  status: number;
  contentType?: string;
  body: string;
}

export class WebhookRejected extends Error {}

// ---- Payments ----

export interface CheckoutInput {
  purchaseId: number;
  tokens: number;
  priceCents: number;
  currency: string;
}

export type PaymentEvent =
  | { purchaseId: number; kind: 'paid'; providerRef?: string; amountCents?: number; currency?: string }
  | { purchaseId: number; kind: 'failed'; providerRef?: string; reason?: string }
  | { purchaseId: number; kind: 'reversed'; providerRef?: string; reason: 'refund' | 'chargeback' | 'void' };

export interface PaymentAdapter {
  checkout(env: AdapterEnv, input: CheckoutInput): Promise<{ redirectUrl: string }>;
  webhook(env: AdapterEnv, req: WebhookRequest): Promise<{ events: PaymentEvent[]; reply?: WebhookReply }>;
}

// ---- Verification ----

export type Decision = 'approved' | 'rejected' | 'pending';

export interface VerificationInput {
  verificationId: number;
  purpose: 'creator_kyc' | 'viewer_age';
  returnUrl: string;
  webhookUrl: string;
}

export interface VerificationAdapter {
  start(env: AdapterEnv, input: VerificationInput): Promise<{ redirectUrl: string; providerRef: string }>;
  /** Fetches the result from the provider (source of truth). */
  fetchResult(env: AdapterEnv, providerRef: string, purpose: 'creator_kyc' | 'viewer_age'): Promise<Decision>;
  /**
   * Processes a notification. Returns the affected verification and, if the notification is signed and trustworthy,
   * the decision; otherwise only the reference to query the provider again.
   */
  webhook(env: AdapterEnv, req: WebhookRequest): Promise<{ verificationId?: number; providerRef?: string; decision?: Decision; reply?: WebhookReply }>;
}

export function header(req: WebhookRequest, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export function toAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
