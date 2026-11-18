import type { PaymentAdapter, VerificationAdapter } from './types.ts';
import { ccbill } from './ccbill.ts';
import { vendo } from './vendo.ts';
import { veriff } from './veriff.ts';
import { yoti } from './yoti.ts';

export const PAYMENT_ADAPTERS: Record<string, PaymentAdapter> = { ccbill, vendo };
export const VERIFICATION_ADAPTERS: Record<string, VerificationAdapter> = { veriff, yoti };
