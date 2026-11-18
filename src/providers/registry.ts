import type { Market } from '../settings.ts';

export type Category = 'payments' | 'creator_kyc' | 'viewer_age' | 'moderation';

export const CATEGORY_LABELS: Record<Category, string> = {
  payments: 'Payments',
  creator_kyc: 'Creator verification',
  viewer_age: 'Viewer age verification',
  moderation: 'Illegal content detection',
};

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  multiline?: boolean;
  /** Not required to switch to live mode. */
  optional?: boolean;
}

export interface ProviderManifest {
  id: string;
  name: string;
  categories: Category[];
  markets: Market[];
  fields: CredentialField[];
  /** false = the field names have not yet been checked against the provider's documentation. */
  fieldsConfirmed: boolean;
  /** false = works in test mode only (simulation); the live integration is pending. */
  liveImplemented: boolean;
  website: string;
  notes: string;
}

/**
 * Preconfigured providers. In test mode they all use the built-in simulation,
 * so the platform works end to end before any real accounts exist.
 */
export const PROVIDERS: ProviderManifest[] = [
  {
    id: 'ccbill',
    name: 'CCBill',
    categories: ['payments'],
    markets: ['US', 'EU', 'LATAM', 'OTHER'],
    fields: [
      { key: 'clientAccnum', label: 'Account number (clientAccnum)', secret: false },
      { key: 'clientSubacc', label: 'Sub-account (clientSubacc)', secret: false },
      { key: 'flexFormId', label: 'FlexForms form ID (with dynamic pricing enabled)', secret: false },
      { key: 'salt', label: 'Encryption Key (Salt)', secret: true },
    ],
    fieldsConfirmed: true,
    liveImplemented: true,
    website: 'https://ccbill.com/doc/dynamic-pricing-flexforms',
    notes:
      'Cards in the US and Europe. In the CCBill dashboard: enable Dynamic Pricing, ask support for the Salt, and configure the webhook (JSON or form format) with the events NewSaleSuccess, NewSaleFailure, Refund, Chargeback and Void. Notifications are accepted only from the IPs published by CCBill.',
  },
  {
    id: 'vendo',
    name: 'Vendo',
    categories: ['payments'],
    markets: ['LATAM'],
    fields: [
      { key: 'siteId', label: 'Site ID (site)', secret: false },
      { key: 'sharedSecret', label: 'Shared Secret (Backoffice → Catalog → Merchants)', secret: true },
    ],
    fieldsConfirmed: true,
    liveImplemented: true,
    website: 'https://docs.vendoservices.com/docs/custom-offer-link.md',
    notes:
      'Pix (Brazil), OXXO (Mexico) and card, with a signed offer link. Set the postback URL in Vendo. Notifications are accepted only from Vendo\'s public IP list.',
  },
  {
    id: 'yoti',
    name: 'Yoti',
    categories: ['creator_kyc', 'viewer_age'],
    markets: ['US', 'EU', 'LATAM', 'OTHER'],
    fields: [
      { key: 'clientSdkId', label: 'Client SDK ID (Yoti Hub)', secret: false },
      { key: 'pemKey', label: 'PEM private key (creator verification)', secret: true, multiline: true, optional: true },
      { key: 'ageApiKey', label: 'Age Verification API key (viewers)', secret: true, optional: true },
      { key: 'environment', label: 'Creator environment: “sandbox” or empty for production', secret: false, optional: true },
      { key: 'estimationThreshold', label: 'Facial estimation threshold (default 25)', secret: false, optional: true },
    ],
    fieldsConfirmed: true,
    liveImplemented: true,
    website: 'https://developers.yoti.com',
    notes: 'Creators: document + liveness check + face match (official SDK). Viewers: “over 18” via facial age estimation, digital ID or document.',
  },
  {
    id: 'veriff',
    name: 'Veriff',
    categories: ['creator_kyc'],
    markets: ['US', 'EU', 'LATAM', 'OTHER'],
    fields: [
      { key: 'baseUrl', label: 'API base URL (Customer Portal → Integration → API keys)', secret: false, optional: true },
      { key: 'apiKey', label: 'API key', secret: false },
      { key: 'sharedSecret', label: 'Shared secret key', secret: true },
    ],
    fieldsConfirmed: true,
    liveImplemented: true,
    website: 'https://devdocs.veriff.com',
    notes: 'Fallback for verifying creators. Set the decision notification URL in Veriff; they are checked with its HMAC signature.',
  },
  {
    id: 'eu_age_app',
    name: 'European age verification app',
    categories: ['viewer_age'],
    markets: ['EU'],
    fields: [],
    fieldsConfirmed: false,
    liveImplemented: false,
    website: 'https://ageverification.dev',
    notes:
      'Double anonymity (the site only receives “over 18”). In pilot: the specification is still a conceptual framework and requires deploying your own verifier service (OpenID4VP + mdoc). Pending until it stabilizes.',
  },
  {
    id: 'unico',
    name: 'Unico',
    categories: ['viewer_age'],
    markets: ['LATAM'],
    fields: [],
    fieldsConfirmed: false,
    liveImplemented: false,
    website: 'https://developer.unico.io',
    notes:
      'Local verification for Brazil. Its public documentation is not enough to integrate it: it requires a commercial account and its SDKs. Meanwhile, Brazil uses Yoti in live mode.',
  },
  {
    id: 'hive_csam',
    name: 'Hive (CSAM detection: Thorn hashes + classifier)',
    categories: ['moderation'],
    markets: ['US', 'EU', 'LATAM', 'OTHER'],
    fields: [
      { key: 'apiKey', label: 'CSAM Detection project API key', secret: true },
      { key: 'classifierThreshold', label: 'Classifier threshold to cut the live stream (0–1, default 0.9)', secret: false, optional: true },
    ],
    fieldsConfirmed: true,
    liveImplemented: true,
    website: 'https://docs.thehive.ai/docs/csam-detection-combined-api',
    notes:
      'Checks each frame against hash lists of known material and with a classifier. Requires a commercial contract with Hive. To confirm in their test environment: sending the file (“media”) in the synchronous call.',
  },
  {
    id: 'moderation_webhook',
    name: 'Custom detector (generic connector)',
    categories: ['moderation'],
    markets: ['US', 'EU', 'LATAM', 'OTHER'],
    fields: [
      { key: 'url', label: 'HTTPS URL of your analysis service', secret: false },
      { key: 'secret', label: 'Secret to sign requests (HMAC-SHA256)', secret: true },
    ],
    fieldsConfirmed: true,
    liveImplemented: true,
    website: '',
    notes:
      'For PhotoDNA, Thorn Safer or another service you have access to: we send each frame (image/jpeg) with the X-FTW-Signature header = HMAC-SHA256 of the body, and your service replies {"verdict":"clear"|"suspect"|"match","detail":"…"}.',
  },
];

export function manifest(id: string): ProviderManifest | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
