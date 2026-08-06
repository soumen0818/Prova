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
  /**
   * The backend's settlement asset (`ANCHOR_ASSET`). Compare against `env.depositAsset`, which is
   * what this app prints on every balance — see `useAssetMismatch`. Optional: an older backend
   * won't send it, and a missing value means "cannot check", not "mismatch".
   */
  anchorAsset?: string;
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

/**
 * An API failure, carrying what the server actually said.
 *
 * The previous behaviour threw `Error('/auth/otp/request → 429')` and screens rendered that straight
 * into a toast — so a rate-limited user was shown a URL and a status code. Every message the backend
 * returns is written to be read by a person, so the job here is simply to surface it.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    /** Stable machine code (schema.ErrorCode) — branch on this, never on the message. */
    readonly code: string,
    readonly status: number,
    /** Seconds to wait, from Retry-After on a 429. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when waiting will fix it. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** Fallbacks for the cases where the server said nothing useful, keyed by what the user can do. */
function fallbackMessage(status: number): string {
  if (status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (status === 401) return 'That didn’t work. Please check and try again.';
  if (status === 404) return 'Not found.';
  if (status === 503 || status === 501) return 'This isn’t available right now. Please try later.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return 'Something went wrong. Please try again.';
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch {
    // fetch only rejects on a transport failure, which is nearly always connectivity. Saying so is
    // far more useful than surfacing "Network request failed".
    throw new ApiError(
      'Can’t reach Prova. Check your connection and try again.',
      'network_error',
      0,
    );
  }

  if (!res.ok) {
    // The backend returns { code, message } and the message is written for a person to read.
    let message = '';
    let code = 'internal';
    try {
      const body = (await res.json()) as { code?: string; message?: string };
      if (body?.message) message = body.message;
      if (body?.code) code = body.code;
    } catch {
      // Not JSON (a proxy error page, say) — fall through to the status-based message.
    }

    const retryAfter = Number(res.headers.get('Retry-After'));
    throw new ApiError(
      message || fallbackMessage(res.status),
      code,
      res.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  // 204 and friends carry no body; parsing one would throw on an otherwise successful call.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface OtpRequestResponse {
  status: string;
  /** Present only in development mode: the code to type. */
  devCode?: string;
}

export interface OtpVerifyResponse {
  token: string;
  /** Normalised (trimmed + lowercased), so case differences cannot create two accounts. */
  email: string;
}

export interface PhoneVerifyResponse {
  status: string;
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
/** Sign-in: request a one-time code by email. The email is the account identifier. */
export function requestOtp(email: string): Promise<OtpRequestResponse> {
  return json<OtpRequestResponse>('/auth/otp/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/**
 * KYC step 1: request a code for a contact phone number (full E.164).
 *
 * Separate from sign-in on purpose — the phone is an attribute the anchor needs for compliance and
 * payout contact, not the account identity, so changing it must never cost someone their account.
 */
export function requestPhoneOtp(phone: string): Promise<OtpRequestResponse> {
  return json<OtpRequestResponse>('/kyc/phone/request', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
}

export function verifyPhoneOtp(phone: string, code: string): Promise<PhoneVerifyResponse> {
  return json<PhoneVerifyResponse>('/kyc/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ phone, code }),
  });
}

/** Verify a sign-in code, returning a session token and the normalised email. */
export function verifyOtp(email: string, code: string): Promise<OtpVerifyResponse> {
  return json<OtpVerifyResponse>('/auth/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
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

// ---------------------------------------------------------------------------
// Shielded pool (Phase 4) — Docs/shielded-pool.md §10.7
//
// The wallet holds its own note secrets but has no view of the Merkle tree, because the contract
// stores only a root. These endpoints are what let it spend at all: where is my note, how do I prove
// it, and what arrived for me.
//
// Nothing sensitive is sent. The scan feed is deliberately unfiltered — asking the server for "my
// notes" would tell it who is being paid — so the wallet downloads everything and trial-decrypts
// locally.
// ---------------------------------------------------------------------------

/** One note from the scan feed, as served by the indexer. */
export interface PoolNoteRecord {
  queueIndex: number;
  commitment: string;
  encrypted: {
    epkX: string;
    epkY: string;
    encAmount: string;
    encRho: string;
    slot: number;
  };
  /** Present only once folded. Absent means real money that is not yet spendable. */
  leafIndex?: number;
  ledger: number;
}

export interface PoolScanResponse {
  notes: PoolNoteRecord[];
  /** Resume cursor for the next poll. */
  next: number;
}

export interface PoolMerklePath {
  leafIndex: number;
  /** Exactly MerkleDepth siblings, leaf level upward. */
  siblings: string[];
  root: string;
}

export interface PoolStatus {
  root?: string;
  treeSize: number;
  ledger?: number;
  /** Commitments waiting to be folded. A rising number means the folder has stalled. */
  queueDepth: number;
  batch: number;
}

export interface PoolSpendBody {
  proof: string;
  root: string;
  nullifier: string;
  outputs: {
    c1: string;
    c2: string;
    epkX: string;
    epkY: string;
    enc1Amount: string;
    enc1Rho: string;
    enc2Amount: string;
    enc2Rho: string;
  };
  currentTime: number;
  /** Unshield only; omitted for a private transfer. */
  amount?: number;
  destination?: string;
}

/** Pool health: tree size, current root, and whether the folder is keeping up. */
export function getPoolStatus(): Promise<PoolStatus> {
  return json<PoolStatus>('/pool/status');
}

/** One page of the scan feed, from `after` onward. */
export function getPoolNotes(after: number, limit = 200): Promise<PoolScanResponse> {
  return json<PoolScanResponse>(`/pool/notes?after=${after}&limit=${limit}`);
}

/**
 * Membership path for one note — the private witness of its spend proof.
 *
 * 409 means the note is queued but not yet folded: real money, not yet movable. The caller should
 * wait and retry rather than treat it as missing.
 */
export function getPoolPath(commitment: string): Promise<PoolMerklePath> {
  return json<PoolMerklePath>(`/pool/path/${commitment}`);
}

/** Which of these nullifiers are already spent on-chain. */
export function getSpentNullifiers(nullifiers: string[]): Promise<{ spent: string[] }> {
  return json<{ spent: string[] }>('/pool/spent', {
    method: 'POST',
    body: JSON.stringify({ nullifiers }),
  });
}

/**
 * Relay a spend, so this user's own Stellar account is never recorded next to it.
 *
 * The relayer cannot alter anything — the amount, both output notes, the destination and the
 * encrypted payloads are all bound inside the proof. It can only refuse, and the contract is
 * permissionless, so a user could always submit their own transaction instead.
 */
export function relayPoolSpend(body: PoolSpendBody): Promise<{ txHash: string }> {
  return json<{ txHash: string }>('/pool/spend', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
