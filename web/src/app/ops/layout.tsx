import type { Metadata } from 'next';
import Image from 'next/image';

import { BackendError, listSupportThreads, listVerifications } from '@/lib/backend';
import { isSignedIn } from '@/lib/session';

import { OpsNav } from './nav';
import { signOut } from './actions';
import './ops.css';

export const metadata: Metadata = {
  title: 'Prova operations',
  robots: { index: false, follow: false },
};

/**
 * Shell for every console page.
 *
 * The gate lives here so a new page cannot be added unprotected by accident — but note it is not the
 * *only* gate: each server action re-checks the session itself, because an action is a public POST
 * endpoint and a layout check does not cover it.
 *
 * Sign-in sits in the `(ops-login)` route group so this layout does not wrap it. Nested here, the
 * login page was blocked by its own gate.
 */
export default async function OpsLayout({ children }: { children: React.ReactNode }) {
  if (!(await isSignedIn())) {
    return (
      <main className="ops-login">
        <div className="ops-login-card">
          <Image src="/brand/symbol.png" alt="" width={40} height={40} className="ops-login-mark" />
          <h1>Sign in required</h1>
          <p>Your session has ended.</p>
          <a className="ops-btn ops-btn-primary" href="/ops/login" style={{ width: '100%' }}>
            Sign in
          </a>
        </div>
      </main>
    );
  }

  // Counts for the nav badges. Fetched here so every page shows the same numbers, and failed
  // separately from the pages themselves — an unreachable backend should grey the badges, not blank
  // the screen the operator is trying to read.
  const [queue, threads] = await Promise.all([
    listVerifications('in_review').catch(swallow),
    listSupportThreads('open').catch(swallow),
  ]);

  return (
    <div className="ops-shell">
      <aside className="ops-side">
        <div className="ops-brand">
          <Image src="/brand/symbol.png" alt="" width={32} height={32} />
          <span className="ops-brand-text">
            <span className="ops-brand-name">Prova</span>
            <span className="ops-brand-sub">Operations</span>
          </span>
        </div>

        <OpsNav
          waiting={queue?.length ?? 0}
          unanswered={threads?.filter((t) => t.unread > 0).length ?? 0}
        />

        <div className="ops-side-foot">
          <span className="ops-signed-in">Signed in as the Prova team</span>
          <form action={signOut}>
            <button type="submit" className="ops-btn" style={{ width: '100%' }}>
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="ops-main">{children}</main>
    </div>
  );
}

/** An unreachable backend leaves the badges empty rather than breaking the whole shell. */
function swallow(error: unknown): null {
  if (error instanceof BackendError) return null;
  throw error;
}
