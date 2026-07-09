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

/** Liveness + shared-schema check against the backend. */
export function getHealth(): Promise<HealthResponse> {
  return json<HealthResponse>('/healthz');
}

/** Start a SEP-24 interactive deposit; returns the anchor popup URL to open. */
export function startDeposit(): Promise<DepositResponse> {
  return json<DepositResponse>('/sep24/deposit', { method: 'POST' });
}

/** SEP-12 KYC handoff: the anchor signs a credential for this user id. */
export function submitKyc(userId: string, kycLevel = 2): Promise<KycCredential> {
  return json<KycCredential>('/kyc/credential', {
    method: 'POST',
    body: JSON.stringify({ userId, kycLevel }),
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
