/**
 * Signed-in account — the app-level identity (phone + display name) that gates the whole app.
 *
 * This is distinct from the ZK wallet secret (see lib/wallet.ts): the session is *who you are* to
 * the app; the wallet secret is the private key everything is proved against. Both live on-device.
 */
import { deleteSecret, getSecret, SecureKey, setSecret } from './secure-store';

export interface Session {
  /** E.164-ish phone string as entered (display only). */
  phone: string;
  /** Display name shown around the app. */
  name: string;
  /** Unix seconds the account was created on this device. */
  createdAt: number;
}

export async function getSession(): Promise<Session | null> {
  const raw = await getSecret(SecureKey.session);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export async function saveSession(session: Session): Promise<void> {
  await setSecret(SecureKey.session, JSON.stringify(session));
}

/** Update fields on the existing session (e.g. rename); no-op if not signed in. */
export async function patchSession(patch: Partial<Session>): Promise<Session | null> {
  const current = await getSession();
  if (!current) return null;
  const next = { ...current, ...patch };
  await saveSession(next);
  return next;
}

export async function hasSession(): Promise<boolean> {
  return (await getSecret(SecureKey.session)) !== null;
}

export async function clearSession(): Promise<void> {
  await deleteSecret(SecureKey.session);
}
