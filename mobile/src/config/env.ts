/**
 * Typed runtime configuration.
 *
 * Values come from `EXPO_PUBLIC_*` environment variables (inlined by Expo at build time) with safe
 * testnet defaults so the app runs out of the box. Document every variable in `.env.example`.
 * Only NON-secret, client-safe values belong here — anything sensitive lives server-side or in the
 * secure enclave (see lib/secure-store.ts).
 */

export type AppEnv = 'development' | 'staging' | 'production';
export type StellarNetwork = 'testnet' | 'mainnet';

function str(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

const appEnv = str(process.env.EXPO_PUBLIC_APP_ENV, 'development') as AppEnv;
const network = str(process.env.EXPO_PUBLIC_STELLAR_NETWORK, 'testnet') as StellarNetwork;

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
  network,
  stellar: {
    horizonUrl: str(process.env.EXPO_PUBLIC_HORIZON_URL, STELLAR_DEFAULTS[network].horizon),
    sorobanRpcUrl: str(process.env.EXPO_PUBLIC_SOROBAN_RPC_URL, STELLAR_DEFAULTS[network].soroban),
    networkPassphrase: STELLAR_DEFAULTS[network].passphrase,
  },
  /** Prova backend API base URL (Go service). */
  apiBaseUrl: str(process.env.EXPO_PUBLIC_API_BASE_URL, 'http://localhost:8080'),
  /** Optional Sentry DSN; empty disables remote error reporting. */
  sentryDsn: str(process.env.EXPO_PUBLIC_SENTRY_DSN, ''),
} as const;
