import Link from 'next/link';

import { BackendError, listSupportThreads, listVerifications } from '@/lib/backend';

import { AlertIcon, ArrowRightIcon, ChatIcon, InfoIcon, ShieldIcon } from './icons';

/**
 * What needs attention right now.
 *
 * Two numbers and a way to reach them. A dashboard of charts would be inventing work for a console
 * whose whole job today is answering "is anybody waiting on me?" — so that question is answered in
 * the largest type on the page, and the oldest waiting item is named underneath, because a queue of
 * three where one has been sitting for two days is not the same as a queue of three from this hour.
 */
export default async function OpsOverview() {
  const [queue, threads] = await Promise.all([
    listVerifications('in_review').catch(toNull),
    listSupportThreads('open').catch(toNull),
  ]);

  // `null` means the backend could not be reached. That must not render as "nothing waiting", which
  // reads as an empty queue and quietly hides real work.
  if (queue === null || threads === null) {
    return (
      <>
        <Header />
        <div className="ops-banner">
          <AlertIcon />
          <div>
            <strong>Could not reach the Prova backend.</strong>
            <p style={{ marginTop: 6 }}>
              The queue and the inbox cannot be shown. Check that the backend is running and that{' '}
              <code>PROVA_API_URL</code> points at it — this is not the same as having no work
              waiting.
            </p>
          </div>
        </div>
      </>
    );
  }

  const waiting = queue.length;
  const unanswered = threads.filter((t) => t.unread > 0);
  const oldestReview = oldest(queue.map((v) => v.updatedAt));
  const oldestMessage = oldest(unanswered.map((t) => t.lastMessageAt));

  return (
    <>
      <Header />

      <div className="ops-stats">
        <Link href="/ops/kyc" className={`ops-stat ${waiting > 0 ? 'ops-stat-active' : ''}`}>
          <div className="ops-stat-top">
            <span className="ops-stat-label">
              <ShieldIcon size={16} />
              Verifications to review
            </span>
          </div>
          <div className="ops-stat-value">{waiting}</div>
          <p className="ops-stat-note">
            {waiting === 0
              ? 'The queue is clear.'
              : `Longest wait: ${oldestReview}. We promise a decision within 24 hours.`}
          </p>
          <span className="ops-stat-cta">
            {waiting === 0 ? 'View all verifications' : 'Review now'}
            <ArrowRightIcon />
          </span>
        </Link>

        <Link
          href="/ops/support"
          className={`ops-stat ${unanswered.length > 0 ? 'ops-stat-active' : ''}`}>
          <div className="ops-stat-top">
            <span className="ops-stat-label">
              <ChatIcon size={16} />
              Waiting on a reply
            </span>
          </div>
          <div className="ops-stat-value">{unanswered.length}</div>
          <p className="ops-stat-note">
            {unanswered.length === 0
              ? `Everyone has had a reply. ${threads.length} open ${threads.length === 1 ? 'conversation' : 'conversations'}.`
              : `Longest wait: ${oldestMessage}.`}
          </p>
          <span className="ops-stat-cta">
            {unanswered.length === 0 ? 'Open the inbox' : 'Reply now'}
            <ArrowRightIcon />
          </span>
        </Link>
      </div>

      {waiting === 0 && unanswered.length === 0 ? (
        <div className="ops-empty">
          <div className="ops-empty-mark">
            <InfoIcon size={20} />
          </div>
          <h3>Nothing needs you right now</h3>
          <p>
            New verifications and messages appear here as they arrive. The counts beside the menu
            update on every page.
          </p>
        </div>
      ) : null}

      <div className="ops-note">
        <InfoIcon />
        <span>
          Everyone here is identified by an opaque wallet hash. There is no name, email or document
          anywhere in this system to show instead — that is the design, not a gap in these screens.
        </span>
      </div>
    </>
  );
}

function Header() {
  return (
    <div className="ops-head">
      <h1>Overview</h1>
      <p>What is waiting on you.</p>
    </div>
  );
}

/** Human description of the longest wait in a set of timestamps. */
function oldest(times: string[]): string {
  if (times.length === 0) return 'none';
  const earliest = Math.min(...times.map((t) => new Date(t).getTime()));
  const minutes = Math.floor((Date.now() - earliest) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Turn an unreachable backend into `null` so the caller can tell it apart from an empty list. */
function toNull(error: unknown): null {
  if (error instanceof BackendError) return null;
  throw error;
}
