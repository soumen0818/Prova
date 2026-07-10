/**
 * Typed wrapper around expo-secure-store — the phone's "secure enclave" in Prova's architecture.
 *
 * This is where the most sensitive material lives and NEVER leaves the device:
 *   - the ZK secret key (derived on-device at sign-up)
 *   - the anchor-signed KYC credential (used as a private circuit input)
 *
 * See proposal.md §4.2 (the privacy boundary). Always go through this module — never call
 * expo-secure-store directly from screens, so key names stay centralized and namespaced.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/** Canonical key registry. Add new secret keys here, never inline strings. */
export const SecureKey = {
  zkSecretKey: 'prova.zk_secret_key',
  kycCredential: 'prova.kyc_credential',
  stellarSecret: 'prova.stellar_secret',
  /** Signed-in account: phone + display name (JSON). */
  session: 'prova.session',
  /** Spendable balance in minor units — kept on-device because the amount is private. */
  balance: 'prova.balance',
  /** Saved beneficiaries (JSON array). */
  recipients: 'prova.recipients',
} as const;

export type SecureKeyId = (typeof SecureKey)[keyof typeof SecureKey];

// Require device auth where the platform supports it; only unlock on this device.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function assertNative(): void {
  if (Platform.OS === 'web') {
    // SecureStore is unavailable on web; web is dev-only for Prova. Fail loudly rather than
    // silently persisting secrets somewhere insecure.
    throw new Error('SecureStore is not available on web. Run on a device/emulator.');
  }
}

export async function setSecret(key: SecureKeyId, value: string): Promise<void> {
  assertNative();
  await SecureStore.setItemAsync(key, value, OPTIONS);
}

export async function getSecret(key: SecureKeyId): Promise<string | null> {
  assertNative();
  return SecureStore.getItemAsync(key, OPTIONS);
}

export async function deleteSecret(key: SecureKeyId): Promise<void> {
  assertNative();
  await SecureStore.deleteItemAsync(key, OPTIONS);
}

export async function hasSecret(key: SecureKeyId): Promise<boolean> {
  return (await getSecret(key)) !== null;
}
