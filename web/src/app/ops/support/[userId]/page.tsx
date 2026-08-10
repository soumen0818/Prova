import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { SupportThreadView } from '@prova/shared';

import { BackendError, getSupportThread } from '@/lib/backend';

import { AlertIcon, ArrowLeftIcon, InboxIcon, InfoIcon } from '../../icons';
import { ReplyForm, StatusToggle } from './reply-form';

/**
 * One conversation.
 *
 * Opening it clears the unread badge — that is what an operator means by opening a thread, and read
 * state is a convenience for whoever is working the queue rather than a record of anything.
 */
export default async function ThreadPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;

  let thread: SupportThreadView;
  try {
    thread = await getSupportThread(userId);
  } catch (e) {
    if (e instanceof BackendError && e.status === 400) notFound();
    return (
      <>
        <BackLink />
        <div className="ops-banner">
          <AlertIcon />
          <div>
            <strong>{e instanceof Error ? e.message : 'Could not load this conversation.'}</strong>
          </div>
        </div>
      </>
    );
  }

  const last = thread.messages[thread.messages.length - 1];
  const awaitingReply = last?.author === 'user';

  return (
    <>
      <BackLink />

      <div className="ops-head">
        <h1>Conversation</h1>
        <p>
          <span className="ops-id" title={userId}>
            {userId}
          </span>
        </p>
        <p style={{ marginTop: 10 }}>
          {awaitingReply
            ? 'This person is waiting for a reply.'
            : thread.messages.length === 0
              ? 'No messages yet.'
              : 'You replied last.'}{' '}
          Your reply appears in their app within about five seconds.
        </p>
      </div>

      {thread.messages.length === 0 ? (
        <div className="ops-empty">
          <div className="ops-empty-mark">
            <InboxIcon size={20} />
          </div>
          <h3>Nothing said yet</h3>
          <p>This conversation exists but has no messages.</p>
        </div>
      ) : (
        <div className="thread">
          {thread.messages.map((message) => (
            <div
              key={message.id}
              className={`thread-bubble ${message.author === 'team' ? 'thread-team' : 'thread-user'}`}>
              {message.body}
              <span className="thread-time">
                {message.author === 'team' ? 'You · ' : ''}
                {formatTime(message.sentAt)}
              </span>
            </div>
          ))}
        </div>
      )}

      <ReplyForm userId={userId} />

      <div className="thread-foot">
        <StatusToggle userId={userId} status={thread.status} />
        <span style={{ fontSize: 13.5, color: 'var(--text-muted)' }}>
          {thread.status === 'closed'
            ? 'Filed as resolved. A new message from them reopens it automatically.'
            : 'Closing is filing, not locking — they can always write again.'}
        </span>
      </div>

      <div className="ops-note">
        <InfoIcon />
        <span>
          Never ask for a PIN or recovery phrase, and never accept one. They are the only thing
          standing between this person and losing their money, and we cannot use them for anything.
        </span>
      </div>
    </>
  );
}

function BackLink() {
  return (
    <Link href="/ops/support" className="ops-back">
      <ArrowLeftIcon />
      All conversations
    </Link>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (today) return `Today ${time}`;
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}
