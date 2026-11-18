/**
 * Yoti.
 * - Creators: Identity Verification (Doc Scan) with the official `yoti` SDK (it signs the requests).
 *   Docs: https://developers.yoti.com/identity-verification/quick-start
 * - Viewers: Age Verification API (https://age.yoti.com).
 *   Docs: https://developers.yoti.com/age-verification-api · /age-verification/launch-the-user-view
 * Yoti notifications only trigger a new query: the decision is always read from its API.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import yotiSdk from 'yoti';

// The Yoti SDK is CommonJS: it is imported whole and destructured.
const {
  IDVClient,
  NotificationConfigBuilder,
  RequestedDocumentAuthenticityCheckBuilder,
  RequestedFaceMatchCheckBuilder,
  RequestedLivenessCheckBuilder,
  SdkConfigBuilder,
  SessionSpecificationBuilder,
} = yotiSdk;
import { header, WebhookRejected, type AdapterEnv, type Decision, type VerificationAdapter } from './types.ts';

const IDV_PROD = 'https://api.yoti.com/idverify/v1';
const IDV_SANDBOX = 'https://api.yoti.com/sandbox/idverify/v1';
const AGE_API = 'https://age.yoti.com';

function idvBase(creds: Record<string, string>): string {
  return creds.environment === 'sandbox' ? IDV_SANDBOX : IDV_PROD;
}

function idvClient(creds: Record<string, string>) {
  return new IDVClient(creds.clientSdkId, creds.pemKey, { apiUrl: idvBase(creds) });
}

/** Token Yoti sends back in the Authorization header of each session's notification. */
export function yotiWebhookToken(creds: Record<string, string>, verificationId: number): string {
  return createHmac('sha256', creds.pemKey || creds.ageApiKey || '').update(`ftw-yoti:${verificationId}`).digest('hex');
}

/** Interprets the result of a Doc Scan session from the raw data. */
export function idvDecision(raw: any): Decision {
  const state = String(raw?.state ?? '');
  if (state === 'EXPIRED') return 'rejected';
  if (state !== 'COMPLETED') return 'pending';
  const checks: any[] = raw?.checks ?? [];
  if (!checks.length) return 'rejected';
  const values = checks.map((c) => String(c?.report?.recommendation?.value ?? ''));
  if (values.some((v) => v === 'REJECT' || v === 'NOT_AVAILABLE')) return 'rejected';
  return values.every((v) => v === 'APPROVE') ? 'approved' : 'pending';
}

export function ageDecision(status: string): Decision {
  if (status === 'COMPLETE') return 'approved';
  if (['FAIL', 'CANCELLED', 'ERROR'].includes(status)) return 'rejected';
  return 'pending';
}

function ageHeaders(env: AdapterEnv) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${env.creds.ageApiKey}`,
    'yoti-sdk-id': env.creds.clientSdkId,
  };
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const yoti: VerificationAdapter = {
  async start(env, input) {
    if (input.purpose === 'creator_kyc') {
      const notifications = new NotificationConfigBuilder()
        .withEndpoint(`${input.webhookUrl}/idv/${input.verificationId}`)
        .withAuthToken(yotiWebhookToken(env.creds, input.verificationId))
        .withAuthTypeBearer()
        .withTopic('SESSION_COMPLETION')
        .build();
      const spec = new SessionSpecificationBuilder()
        .withClientSessionTokenTtl(900)
        .withResourcesTtl(7 * 24 * 3600)
        .withUserTrackingId(`ftw-${input.verificationId}`)
        .withNotifications(notifications)
        .withRequestedCheck(new RequestedDocumentAuthenticityCheckBuilder().build())
        .withRequestedCheck(new RequestedLivenessCheckBuilder().forStaticLiveness().withMaxRetries(3).build())
        .withRequestedCheck(new RequestedFaceMatchCheckBuilder().withManualCheckFallback().build())
        .withSdkConfig(new SdkConfigBuilder().withAllowsCameraAndUpload().withSuccessUrl(input.returnUrl).withErrorUrl(input.returnUrl).build())
        .build();
      const session = await idvClient(env.creds).createSession(spec);
      const id = session.getSessionId();
      const url = `${idvBase(env.creds)}/web/index.html?sessionID=${encodeURIComponent(id)}&sessionToken=${encodeURIComponent(session.getClientSessionToken())}`;
      return { redirectUrl: url, providerRef: id };
    }
    const threshold = Number(env.creds.estimationThreshold || 25);
    const res = await env.fetch(`${AGE_API}/api/v1/sessions`, {
      method: 'POST',
      headers: ageHeaders(env),
      body: JSON.stringify({
        type: 'OVER',
        ttl: 900,
        reference_id: String(input.verificationId),
        callback: { url: input.returnUrl, auto: true },
        notification_url: `${input.webhookUrl}/age/${input.verificationId}`,
        // Facial estimation with a margin (threshold above 18); if it falls short, document or digital ID.
        age_estimation: { allowed: true, threshold },
        digital_id: { allowed: true, threshold: 18 },
        doc_scan: { allowed: true, threshold: 18 },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id) throw new Error(`Yoti did not create the age session (${res.status})`);
    const url = `${AGE_API}?sessionId=${encodeURIComponent(data.id)}&sdkId=${encodeURIComponent(env.creds.clientSdkId)}`;
    return { redirectUrl: url, providerRef: String(data.id) };
  },

  async fetchResult(env, providerRef, purpose) {
    if (purpose === 'creator_kyc') {
      const session = await idvClient(env.creds).getSession(providerRef);
      return idvDecision(session.getRawResponse());
    }
    const res = await env.fetch(`${AGE_API}/api/v1/sessions/${encodeURIComponent(providerRef)}/result`, {
      headers: ageHeaders(env),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return 'pending';
    const data: any = await res.json().catch(() => ({}));
    return ageDecision(String(data?.status ?? ''));
  },

  async webhook(env, req) {
    const [kind, idText] = req.subpath.split('/');
    const verificationId = Number(idText);
    if (!Number.isInteger(verificationId) || verificationId <= 0) throw new WebhookRejected('Notification without a verification');
    if (kind === 'idv') {
      const auth = header(req, 'authorization').replace(/^Bearer\s+/i, '');
      if (!sameText(auth, yotiWebhookToken(env.creds, verificationId))) throw new WebhookRejected('Invalid Yoti token');
    } else if (kind !== 'age') {
      throw new WebhookRejected('Unknown Yoti notification');
    }
    // No decision: the service queries Yoti again.
    return { verificationId };
  },
};
