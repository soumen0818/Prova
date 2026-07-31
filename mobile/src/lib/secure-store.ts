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
  /** The single 32-byte master seed the ZK secret + Stellar key are derived from (hex). */
  masterSeed: 'prova.master_seed',
  zkSecretKey: 'prova.zk_secret_key',
  kycCredential: 'prova.kyc_credential',
  stellarSecret: 'prova.stellar_secret',
  /** Stellar public `G…` address — not secret, cached for display/receive. */
  stellarPublic: 'prova.stellar_public',
  /** PIN verifier record (salt + PBKDF2 hash + attempt/lockout state) as JSON. Never the raw PIN. */
  pinRecord: 'prova.pin_record',
  /** Encrypted vault "box" (envelope: DEK-sealed data + Argon2id/PIN-wrapped DEK) as JSON. */
  vaultBox: 'prova.vault_box',
  /** Cached vault data-encryption key (hex) for fast re-seals; same trust level as masterSeed. */
  vaultDek: 'prova.vault_dek',
  /** Cloud-backup state (JSON: enabled, provider, account, lastSyncedAt). Not secret, kept together. */
  backupMeta: 'prova.backup_meta',
  /** Signed-in account: phone + display name (JSON). */
  session: 'prova.session',
  /** Spendable balance in minor units — kept on-device because the amount is private. */
  balance: 'prova.balance',
  /** Saved beneficiaries (JSON array). */
  recipients: 'prova.recipients',
  /**
   * AES key for the encrypted note file (hex).
   *
   * Deliberately NOT derived from the master seed: it only protects a rebuildable cache, so it is
   * never backed up. Losing it costs a rescan, not money — every note is also published on-chain
   * encrypted to its owner, so a wallet restores from the seed alone.
   */
  noteStoreKey: 'prova.note_store_key',
  /** Pool keys (JSON: ownerPk + encPk). The secrets stay derived, never persisted here. */
  poolAddress: 'prova.pool_address',
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
