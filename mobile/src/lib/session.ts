/**
 * Signed-in account — the app-level identity that gates the whole app.
 *
 * The **email is the account**: it is what sign-in proves, and the only field present from the
 * moment someone signs up. Name and phone arrive later, during identity verification, because they
 * are things the anchor needs for compliance rather than things the app needs to let you in. Keeping
 * them out of sign-up means a user can change their phone number without risking their account.
 *
 * Distinct from the ZK wallet secret (see lib/wallet.ts): the session is *who you are* to the app;
 * the wallet secret is the private key everything is proved against. Both live on-device.
 */
import { deleteSecret, getSecret, SecureKey, setSecret } from './secure-store';

export interface Session {
  /** Normalised email — the account identifier, proved at sign-in. */
  email: string;
  /**
   * Legal name, captured during identity verification. Absent until then.
   *
   * Deliberately not shown around the app: it is compliance data the anchor requires, not a display
   * preference, and putting a real name on the home screen of a privacy product is the wrong signal.
   */
  name?: string;
  /** Verified contact number in E.164, captured during identity verification. Absent until then. */
  phone?: string;
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
