import 'server-only';

import type {
  SupportMessage,
  SupportThreadRecord,
  SupportThreadView,
  VerificationRecord,
} from '@prova/shared';

/**
 * A queue row: the app-facing verification record, the userId the console acts on, and the account
 * that submitted it.
 *
 * Mirrors `schema.QueuedVerification` in the Go backend.
 *
 * `email` is present only when the app sent one, and it is a **label, not proof**. The backend has
 * no session to have checked it against, so it identifies the row for a human without authorising
 * anything: no decision reads it. `userId` remains what every action is keyed on.
 */
export type QueuedVerification = VerificationRecord & { userId: string; email?: string };

/**
 * Server-side client for the Prova backend's `/ops` routes.
 *
 * ## Why the browser never talks to the backend directly
 *
 * These endpoints are gated by `COMPLIANCE_TOKEN` — the same secret that can approve anybody's KYC.
 * Sending it from a browser would put it in devtools, in extensions, and in any script that manages
 * to run on the page. So every console page renders on the server, calls this module, and ships only
 * the resulting data. As a side effect there is no CORS to configure: the backend is never contacted
 * from an origin at all.
 */

function baseUrl(): string {
  const url = process.env.PROVA_API_URL ?? 'http://localhost:8080';
  return url.replace(/\/$/, '');
}

/** Anything the backend refused, carrying its status so pages can tell 401 from 503. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

const TIMEOUT_MS = 10_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.COMPLIANCE_TOKEN ?? '';
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        // An unset token is sent as nothing rather than as "Bearer ". The backend skips the check
        // when it has no token configured (local dev); against a configured backend this fails
        // closed with a 401, which is the honest outcome.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
      // Console data is a live queue. Caching it would show an operator work that is already done.
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new BackendError('Could not reach the Prova backend.', 0);
  }

  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Not a JSON error envelope — the status-based message stands.
    }
    throw new BackendError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The KYC review queue. `status` empty means every status. */
export function listVerifications(status = ''): Promise<QueuedVerification[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<QueuedVerification[]>(`/ops/kyc/verifications${query}`);
}

/** Record a compliance decision. */
export function decideVerification(
  userId: string,
  decision: 'approved' | 'rejected',
  reasonCode?: string,
): Promise<unknown> {
  return request(`/kyc/verifications/${encodeURIComponent(userId)}/decide`, {
    method: 'POST',
    // `reviewer` is what lands in the audit log's actor column. One operator today, so a role name
    // is more truthful than inventing a person.
    body: JSON.stringify({ decision, reasonCode, reviewer: 'ops-console' }),
  });
}

/** The support inbox. */
export function listSupportThreads(status = ''): Promise<SupportThreadRecord[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<SupportThreadRecord[]>(`/ops/support/threads${query}`);
}

/** One conversation, marking it read. */
export function getSupportThread(userId: string): Promise<SupportThreadView> {
  return request<SupportThreadView>(`/ops/support/threads/${encodeURIComponent(userId)}`);
}

/** Reply as the team. */
export function replyToThread(userId: string, body: string): Promise<SupportMessage> {
  return request<SupportMessage>(`/ops/support/threads/${encodeURIComponent(userId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

/** File a conversation as open or closed. */
export function setThreadStatus(userId: string, status: 'open' | 'closed'): Promise<void> {
  return request<void>(`/ops/support/threads/${encodeURIComponent(userId)}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}
