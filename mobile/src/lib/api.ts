/**
 * Thin client for the Prova Go backend (Phase 2 rails).
 *
 * The amount never leaves the device, so it is never sent here. This talks to the backend for
 * anchor deposit (SEP-24) and, later, transfer relay.
 */
import { Platform } from 'react-native';

import { env } from '@/config/env';

/** Resolve the backend base URL, accounting for the Android emulator's host alias. */
function baseUrl(): string {
  let u = env.apiBaseUrl;
  // The Android emulator reaches the host machine via 10.0.2.2, not localhost/127.0.0.1.
  if (Platform.OS === 'android') {
    u = u.replace('localhost', '10.0.2.2').replace('127.0.0.1', '10.0.2.2');
  }
  return u.replace(/\/$/, '');
}

export interface HealthResponse {
  status: string;
  env: string;
  schemaVersion: string;
  /** Server-announced planned downtime — the app renders its maintenance screen from this. */
  maintenance?: boolean;
  maintenanceMessage?: string;
  /** ISO-8601 estimate of when service returns. */
  maintenanceUntil?: string;
  /** Round-trip time we measured for this probe (client-side, not from the server). */
  latencyMs?: number;
}

export interface DepositResponse {
  account: string;
  url: string;
  id: string;
}

export interface TransferResponse {
  transferId: string;
  status: string;
  txHash?: string;
}

export interface TransferRecord {
  transferId: string;
  status: string;
  commitment: string;
  nullifier: string;
  createdAt: string;
  updatedAt: string;
  txHash?: string;
}

export interface KycCredential {
  userId: string;
  kycLevel: number;
  expiry: number;
  signature: { rX: string; rY: string; s: string };
  anchor: { x: string; y: string };
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface OtpRequestResponse {
  status: string;
  /** Present only in development mode: the code to type. */
  devCode?: string;
}

export interface OtpVerifyResponse {
  token: string;
  phone: string;
}

/**
 * Liveness + shared-schema check, and the carrier for server-announced maintenance.
 *
 * Also measures round-trip time so the UI can distinguish "slow connection" from "broken" — a
 * distinction that matters before someone taps Pay.
 */
export async function getHealth(): Promise<HealthResponse> {
  const started = Date.now();
  const res = await json<HealthResponse>('/healthz');
  return { ...res, latencyMs: Date.now() - started };
}

/** Request an SMS OTP for a phone number (production auth path). */
export function requestOtp(phone: string): Promise<OtpRequestResponse> {
  return json<OtpRequestResponse>('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
}

/** Verify an OTP code, returning a session token (production auth path). */
export function verifyOtp(phone: string, code: string): Promise<OtpVerifyResponse> {
  return json<OtpVerifyResponse>('/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ phone, code }),
  });
}

/** Start a SEP-24 interactive deposit to the user's own Stellar address; returns the anchor URL. */
export function startDeposit(address?: string): Promise<DepositResponse> {
  return json<DepositResponse>('/sep24/deposit', {
    method: 'POST',
    body: JSON.stringify(address ? { address } : {}),
  });
}

// ---- On-chain wallet (real testnet deposit flow) ----

export interface OnChainBalance {
  code: string;
  issuer: string;
  balance: string;
}
export interface AccountState {
  exists: boolean;
  balances: OnChainBalance[];
}
/** An unsigned Stellar tx the phone must sign (server-prepared; the phone signs only the hash). */
export interface UnsignedTx {
  xdr: string;
  hash: string;
  network: string;
  /** Human-readable description of what the tx does — shown before signing (no blind-signing). */
  summary: string;
}

/** A SEP-10 challenge the user must sign to authenticate for a deposit. */
export interface DepositChallenge {
  xdr: string;
  hash: string;
  network: string;
  webAuth: string;
  summary: string;
}

/** Read the account's on-chain existence + balances from Horizon (via the backend). */
export function getAccountState(address: string): Promise<AccountState> {
  return json<AccountState>(`/wallet/${encodeURIComponent(address)}`);
}

/** Activate a new testnet account via Friendbot. */
export function fundAccount(address: string): Promise<AccountState> {
  return json<AccountState>('/wallet/fund', {
    method: 'POST',
    body: JSON.stringify({ address }),
  });
}

/** Ask the backend to build the (unsigned) trustline transaction. */
export function prepareTrustline(address: string): Promise<UnsignedTx> {
  return json<UnsignedTx>('/wallet/trustline/prepare', {
    method: 'POST',
    body: JSON.stringify({ address }),
  });
}

/** Submit the phone-signed trustline transaction; returns the on-chain tx hash. */
export function submitTrustline(
  xdr: string,
  publicKey: string,
  signature: string,
): Promise<{ hash: string }> {
  return json<{ hash: string }>('/wallet/trustline/submit', {
    method: 'POST',
    body: JSON.stringify({ xdr, publicKey, signature }),
  });
}

/** Fetch a SEP-10 challenge for the user's account (step 1 of the user-authenticated deposit). */
export function prepareDeposit(address: string): Promise<DepositChallenge> {
  return json<DepositChallenge>('/sep24/deposit/prepare', {
    method: 'POST',
    body: JSON.stringify({ address }),
  });
}

/** Submit the user-signed challenge and start the deposit; returns the anchor URL (step 2). */
export function completeDeposit(args: {
  address: string;
  xdr: string;
  webAuth: string;
  network: string;
  publicKey: string;
  signature: string;
}): Promise<DepositResponse> {
  return json<DepositResponse>('/sep24/deposit/complete', {
    method: 'POST',
    body: JSON.stringify(args),
  });
}

/** Lifecycle state of a KYC verification (mirrors the backend state machine). */
export type VerificationStatus =
  'not_started' | 'pending' | 'in_review' | 'approved' | 'rejected' | 'expired';

/** Status view of a verification. Carries no personal data — only status, tier and expiry. */
export interface VerificationRecord {
  verificationId?: string;
  status: VerificationStatus;
  tier: number;
  expiry?: number;
  reasonCode?: string;
  retryable?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Artefacts captured on-device. The images themselves never leave the phone. */
export type CapturedArtifact = 'document_front' | 'document_back' | 'selfie' | 'proof_of_address';

/**
 * Start a KYC verification.
 *
 * Sends only the opaque `userId` and the requested tier — **never** documents or personal data.
 * In a real deployment the captured images go straight from the device to the verification
 * provider, so Prova's backend has no identity data to store. See Docs/kyc-verification.md §3.
 */
export function startVerification(
  userId: string,
  tier = 2,
  captured: CapturedArtifact[] = [],
): Promise<VerificationRecord> {
  return json<VerificationRecord>('/kyc/verifications', {
    method: 'POST',
    body: JSON.stringify({ userId, tier, captured }),
  });
}

/** Current verification status for a wallet. */
export function getVerification(userId: string): Promise<VerificationRecord> {
  return json<VerificationRecord>(`/kyc/verifications/${encodeURIComponent(userId)}`);
}

/**
 * Fetch the anchor-signed credential. The backend issues it **only** against a stored `approved`
 * verification — a 403 means verification isn't approved (not a client bug).
 */
export function fetchCredential(userId: string): Promise<KycCredential> {
  return json<KycCredential>('/kyc/credential', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

/** Renew the credential before expiry (re-screens, then re-issues with a fresh window). */
export function renewCredential(userId: string): Promise<KycCredential> {
  return json<KycCredential>('/kyc/credential/renew', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

/** Relay a proof (raw blob from the on-device prover) to the contract via the backend. */
export function submitTransfer(proofBlob: string): Promise<TransferResponse> {
  return json<TransferResponse>('/transfers', {
    method: 'POST',
    body: JSON.stringify({ proofBlob }),
  });
}

/** Recent transfer history (from the backend's relays + on-chain indexer). */
export function getHistory(): Promise<TransferRecord[]> {
  return json<TransferRecord[]>('/transfers');
}

/** The resolved backend base URL (for display/debugging). */
export const apiBaseUrl = baseUrl();
