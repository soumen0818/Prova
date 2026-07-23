/**
 * Cloud backup — stores the encrypted vault box in the *user's own* cloud (Docs/account-recovery.md
 * §3, Phase B). iOS → iCloud (CloudKit, no sign-in needed); Android → the hidden Google Drive
 * `appDataFolder` (needs a one-tap Google sign-in for a Drive token).
 *
 * Only ciphertext ever leaves the device: the box is AES-256-GCM sealed and its key is wrapped
 * under Argon2id(PIN). Prova's backend is never involved; Google/Apple cannot read the box.
 *
 * **Both native modules are loaded lazily.** This file is reachable from the query layer (and so
 * from nearly every screen), so a top-level import of a module that isn't in the installed build
 * would throw at import time and white-screen the whole app. Loading on demand means an older build
 * simply reports "rebuild required" when backup is used, and the rest of the app runs normally.
 */
import { Platform } from 'react-native';

import { env } from '@/config/env';
import { deleteSecret, getSecret, SecureKey, setSecret } from './secure-store';
import { parseVaultBox, resealVault, sealVault, type VaultBox } from './vault';

/** Where the box lives inside the app-private cloud scope. */
const VAULT_PATH = '/prova-vault.json';

/** Structured failure reasons the UI can render precisely. */
export type BackupErrorCode =
  | 'setup_required' // Android: no Google web client ID configured in env
  | 'rebuild_required' // native module missing (app built before Phase B)
  | 'cancelled' // user dismissed the Google sign-in sheet
  | 'unavailable' // iCloud off / no Google Play services
  | 'not_found' // no backup file in this cloud account
  | 'failed'; // network / provider error

export class BackupError extends Error {
  code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface BackupMeta {
  enabled: boolean;
  provider: 'icloud' | 'googledrive';
  /** Account label shown in the UI (Google email, or "iCloud"). */
  account: string | null;
  /** Unix seconds of the last successful upload. */
  lastSyncedAt: number;
}

export async function getBackupMeta(): Promise<BackupMeta | null> {
  const raw = await getSecret(SecureKey.backupMeta);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackupMeta;
  } catch {
    return null;
  }
}

async function setBackupMeta(meta: BackupMeta): Promise<void> {
  await setSecret(SecureKey.backupMeta, JSON.stringify(meta));
}

/** The provider this platform uses. */
export function backupProvider(): 'icloud' | 'googledrive' {
  return Platform.OS === 'ios' ? 'icloud' : 'googledrive';
}

/** Lazy-load Google Sign-In (native module may be absent on pre-Phase-B dev builds). */
function googleSignin(): typeof import('@react-native-google-signin/google-signin') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@react-native-google-signin/google-signin');
  } catch {
    return null;
  }
}

/**
 * Lazy-load the cloud-storage module, or fail with a message the UI can explain. Never imported at
 * module scope — see the file header (a missing native module must not break app startup).
 */
function requireCloud(): typeof import('react-native-cloud-storage') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-cloud-storage');
  } catch {
    throw new BackupError(
      'rebuild_required',
      'This build is missing the cloud module — rebuild the app.',
    );
  }
}

/**
 * Connect the cloud provider and return the account label.
 * - iOS: verifies iCloud availability (no interaction).
 * - Android: Google sign-in (`interactive` controls whether the account sheet may appear), then
 *   hands the Drive access token to the storage layer.
 */
async function connect(interactive: boolean): Promise<string> {
  const { CloudStorage, CloudStorageProvider } = requireCloud();
  if (backupProvider() === 'icloud') {
    CloudStorage.setProvider(CloudStorageProvider.ICloud);
    const available = await CloudStorage.isCloudAvailable();
    if (!available) {
      throw new BackupError(
        'unavailable',
        'iCloud is not available. Sign in to iCloud in Settings.',
      );
    }
    return 'iCloud';
  }

  // Android → Google Drive.
  if (!env.googleWebClientId) {
    throw new BackupError('setup_required', 'Google backup is not configured for this build.');
  }
  const gs = googleSignin();
  if (!gs) {
    throw new BackupError(
      'rebuild_required',
      'This build is missing the Google module — rebuild the app.',
    );
  }

  const { GoogleSignin } = gs;
  GoogleSignin.configure({
    webClientId: env.googleWebClientId,
    scopes: ['https://www.googleapis.com/auth/drive.appdata'],
  });

  let email: string | null = null;
  const silent = await GoogleSignin.signInSilently().catch(() => null);
  if (silent && silent.type === 'success') {
    email = silent.data.user.email;
  } else if (interactive) {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true }).catch(() => {
      throw new BackupError('unavailable', 'Google Play services are unavailable on this device.');
    });
    const res = await GoogleSignin.signIn();
    if (res.type !== 'success') {
      throw new BackupError('cancelled', 'Google sign-in was cancelled.');
    }
    email = res.data.user.email;
  } else {
    throw new BackupError('unavailable', 'Not signed in to Google.');
  }

  const { accessToken } = await GoogleSignin.getTokens();
  CloudStorage.setProvider(CloudStorageProvider.GoogleDrive);
  CloudStorage.setProviderOptions({ accessToken });
  return email ?? 'Google Drive';
}

async function upload(box: VaultBox): Promise<void> {
  const { CloudStorage, CloudStorageScope } = requireCloud();
  await CloudStorage.writeFile(VAULT_PATH, JSON.stringify(box), CloudStorageScope.AppData);
}

/**
 * Enable cloud backup: connect (interactive), seal the vault under `pin` (slow — Argon2id, show
 * progress UI), upload, and record the backup state. Returns the account label.
 */
export async function enableBackup(pin: string): Promise<string> {
  const account = await connect(true);
  const box = await sealVault(pin);
  try {
    await upload(box);
  } catch (e) {
    throw asBackupError(e);
  }
  await setBackupMeta({
    enabled: true,
    provider: backupProvider(),
    account,
    lastSyncedAt: Math.floor(Date.now() / 1000),
  });
  return account;
}

/**
 * Sync the backup with current on-device state (fast — AES-only reseal, silent connect). Call after
 * balance/KYC/recipient changes. Never throws when `quiet` (default): background sync must not
 * break the calling flow — it returns false and the next sync retries.
 */
export async function syncBackup(quiet = true): Promise<boolean> {
  try {
    const meta = await getBackupMeta();
    if (!meta?.enabled) return false;
    await connect(false);
    const box = await resealVault();
    if (!box) return false;
    await upload(box);
    await setBackupMeta({ ...meta, lastSyncedAt: Math.floor(Date.now() / 1000) });
    return true;
  } catch (e) {
    if (!quiet) throw asBackupError(e);
    return false;
  }
}

/**
 * Fetch the backup box from the cloud (restore flow — interactive sign-in allowed). Returns the
 * parsed box plus the account label. Throws `not_found` if this cloud account has no backup.
 */
export async function fetchCloudBackup(): Promise<{ box: VaultBox; account: string }> {
  const account = await connect(true);
  const { CloudStorage, CloudStorageScope } = requireCloud();
  let raw: string;
  try {
    const exists = await CloudStorage.exists(VAULT_PATH, CloudStorageScope.AppData);
    if (!exists) throw new BackupError('not_found', 'No Prova backup found in this account.');
    raw = await CloudStorage.readFile(VAULT_PATH, CloudStorageScope.AppData);
  } catch (e) {
    throw asBackupError(e);
  }
  const box = parseVaultBox(raw);
  if (!box) throw new BackupError('failed', 'The backup file is damaged.');
  return { box, account };
}

/** Mark backup enabled after a successful restore (the cloud copy already exists). */
export async function adoptBackupMeta(account: string): Promise<void> {
  await setBackupMeta({
    enabled: true,
    provider: backupProvider(),
    account,
    lastSyncedAt: Math.floor(Date.now() / 1000),
  });
}

/** Turn off backup and delete the cloud copy (best-effort). */
export async function disableBackup(): Promise<void> {
  try {
    await connect(false);
    const { CloudStorage, CloudStorageScope } = requireCloud();
    if (await CloudStorage.exists(VAULT_PATH, CloudStorageScope.AppData)) {
      await CloudStorage.unlink(VAULT_PATH, CloudStorageScope.AppData);
    }
  } catch {
    // Best-effort: the box is ciphertext; a stale copy is not a security failure.
  }
  await deleteSecret(SecureKey.backupMeta);
}

/** Clear backup state locally (wallet reset — leaves any cloud copy untouched). */
export async function clearBackupMeta(): Promise<void> {
  await deleteSecret(SecureKey.backupMeta);
}

function asBackupError(e: unknown): BackupError {
  if (e instanceof BackupError) return e;
  const msg = e instanceof Error ? e.message : 'Cloud backup failed';
  return new BackupError('failed', msg);
}
