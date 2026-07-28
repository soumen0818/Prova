/**
 * Typed runtime configuration.
 *
 * Values come from `EXPO_PUBLIC_*` environment variables (inlined by Expo at build time) with safe
 * testnet defaults so the app runs out of the box. Document every variable in `.env.example`.
 * Only NON-secret, client-safe values belong here — anything sensitive lives server-side or in the
 * secure enclave (see lib/secure-store.ts).
 */

import { SCHEMA_VERSION, type StellarNetwork } from '@prova/shared';

export type AppEnv = 'development' | 'staging' | 'production';
// StellarNetwork is sourced from the shared cross-component contract (@prova/shared).
export type { StellarNetwork };

function str(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

export type AuthMode = 'development' | 'production';

const appEnv = str(process.env.EXPO_PUBLIC_APP_ENV, 'development') as AppEnv;
const network = str(process.env.EXPO_PUBLIC_STELLAR_NETWORK, 'testnet') as StellarNetwork;
const authMode = str(process.env.EXPO_PUBLIC_AUTH_MODE, 'development') as AuthMode;

/**
 * How adding money works — independent of the login mode (see backend DEPOSIT_MODE):
 *   "simulated" → credit a local testnet balance instantly (fast dev loop, no chain).
 *   "anchor"    → real testnet rails: activate the account, add a trustline, read the on-chain
 *                 balance. Still testnet — no real value.
 */
export type DepositMode = 'simulated' | 'anchor';
const depositMode = str(process.env.EXPO_PUBLIC_DEPOSIT_MODE, 'simulated') as DepositMode;

const STELLAR_DEFAULTS: Record<
  StellarNetwork,
  { horizon: string; soroban: string; passphrase: string }
> = {
  testnet: {
    horizon: 'https://horizon-testnet.stellar.org',
    soroban: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
  },
  mainnet: {
    horizon: 'https://horizon.stellar.org',
    soroban: 'https://mainnet.sorobanrpc.com',
    passphrase: 'Public Global Stellar Network ; September 2015',
  },
};

export const env = {
  appEnv,
  isProd: appEnv === 'production',
  /** Version of the shared cross-component contract (@prova/shared) this build was compiled against. */
  schemaVersion: SCHEMA_VERSION,
  network,
  stellar: {
    horizonUrl: str(process.env.EXPO_PUBLIC_HORIZON_URL, STELLAR_DEFAULTS[network].horizon),
    sorobanRpcUrl: str(process.env.EXPO_PUBLIC_SOROBAN_RPC_URL, STELLAR_DEFAULTS[network].soroban),
    networkPassphrase: STELLAR_DEFAULTS[network].passphrase,
  },
  /** Prova backend API base URL (Go service). */
  apiBaseUrl: str(process.env.EXPO_PUBLIC_API_BASE_URL, 'http://localhost:8080'),
  /**
   * Google OAuth **web** client ID (from Google Cloud console) — required for Google Drive cloud
   * backup on Android. Empty disables Drive backup with an in-app "setup required" notice.
   * iOS uses iCloud and does not need it.
   */
  googleWebClientId: str(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, ''),
  /** Optional Sentry DSN; empty disables remote error reporting. */
  sentryDsn: str(process.env.EXPO_PUBLIC_SENTRY_DSN, ''),
  /**
   * Phone-login credential mode.
   *  - `development`: OTP is bypassed on-device with a fixed dev code, so the app works without an
   *    SMS provider. A dev phone + code are pre-filled to make sign-in one tap.
   *  - `production`: OTP is requested/verified through the backend (real SMS provider). Flip
   *    `EXPO_PUBLIC_AUTH_MODE=production` once real credentials are wired — no code changes needed.
   */
  auth: {
    mode: authMode,
    isDev: authMode === 'development',
    devPhone: str(process.env.EXPO_PUBLIC_DEV_PHONE, '+971 50 123 4567'),
    devOtp: str(process.env.EXPO_PUBLIC_DEV_OTP, '000000'),
  },
  /** Display currency (funding side). */
  currency: str(process.env.EXPO_PUBLIC_CURRENCY, 'AED'),
  /** How adding money works: 'simulated' (local counter) vs 'anchor' (real testnet rails). */
  depositMode,
  /** On-chain deposit asset code (matches the backend's ANCHOR_ASSET). */
  depositAsset: str(process.env.EXPO_PUBLIC_DEPOSIT_ASSET, 'SRT'),
} as const;
