import Link from 'next/link';
import type { SupportThreadRecord } from '@prova/shared';

import { BackendError, listSupportThreads } from '@/lib/backend';

import { AlertIcon, ArrowRightIcon, InboxIcon, InfoIcon } from '../icons';

const FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: '', label: 'All' },
] as const;

/**
 * The support inbox.
 *
 * Ordered by most recent activity, which is also roughly "who has waited longest for an answer".
 * Threads awaiting a reply carry an accent edge so the ones that need you are visible while
 * scanning, without adding another badge to read.
 */
export default async function SupportInbox({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const active = status ?? 'open';

  let threads: SupportThreadRecord[] = [];
  let error: string | null = null;
  try {
    threads = await listSupportThreads(active);
  } catch (e) {
    error = e instanceof BackendError ? e.message : 'Could not load conversations.';
  }

  const awaiting = threads.filter((t) => t.unread > 0).length;

  return (
    <>
      <div className="ops-head">
        <h1>Conversations</h1>
        <p>
          Messages from people using the app, and enquiries from the website contact form. Replies
          appear in the app&rsquo;s chat screen within about five seconds.
          {awaiting > 0
            ? ` ${awaiting} ${awaiting === 1 ? 'person is' : 'people are'} waiting to hear back.`
            : ''}
        </p>
      </div>

      <div className="ops-filters">
        {FILTERS.map((filter) => (
          <Link
            key={filter.label}
            href={filter.value ? `/ops/support?status=${filter.value}` : '/ops/support?status='}
            aria-current={active === filter.value}>
            {filter.label}
          </Link>
        ))}
      </div>

      {error ? (
        <div className="ops-banner">
          <AlertIcon />
          <div>
            <strong>{error}</strong>
            <p style={{ marginTop: 6 }}>
              This is a connection problem, not an empty inbox — messages may still be waiting.
            </p>
          </div>
        </div>
      ) : threads.length === 0 ? (
        <div className="ops-empty">
          <div className="ops-empty-mark">
            <InboxIcon size={20} />
          </div>
          <h3>{active === 'open' ? 'No open conversations' : 'Nothing here'}</h3>
          <p>
            Messages sent from the app&rsquo;s chat screen or the website contact form arrive here.
          </p>
        </div>
      ) : (
        <div className="ops-list">
          {threads.map((thread) => (
            <Link
              key={thread.userId}
              href={`/ops/support/${thread.userId}`}
              className={`ops-row ${thread.unread > 0 ? 'ops-row-unread' : ''}`}>
              <div className="ops-row-main">
                <div className="ops-row-title">
                  <span className="ops-id" title={thread.userId}>
                    {shorten(thread.userId)}
                  </span>
                </div>
                <div className="ops-preview">
                  {thread.lastAuthor === 'team' ? (
                    <span style={{ color: 'var(--text-muted)' }}>You: </span>
                  ) : null}
                  {firstLine(thread.lastMessage) || 'No messages yet'}
                </div>
                <div className="ops-meta">
                  {formatRelative(thread.lastMessageAt)}
                  {thread.unread > 0 ? ' · awaiting your reply' : ''}
                </div>
              </div>

              <div className="ops-actions">
                {thread.unread > 0 ? (
                  <span className="pill pill-unread">{thread.unread} new</span>
                ) : (
                  <span className="pill">{thread.status}</span>
                )}
                <ArrowRightIcon />
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className="ops-note">
        <InfoIcon />
        <span>
          Website enquiries arrive with the sender&rsquo;s name and email in the message body —
          those people have no app to read a reply in, so answer them from your email client.
        </span>
      </div>
    </>
  );
}

function shorten(userId: string): string {
  return userId.length <= 20 ? userId : `${userId.slice(0, 10)}…${userId.slice(-6)}`;
}

/** Previews are one line; a multi-line message would otherwise blow the row height apart. */
function firstLine(text?: string): string {
  if (!text) return '';
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim();
}

function formatRelative(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
