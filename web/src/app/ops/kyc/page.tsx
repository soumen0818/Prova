import Link from 'next/link';

import { BackendError, listVerifications, type QueuedVerification } from '@/lib/backend';

import { AlertIcon, CheckIcon, InfoIcon } from '../icons';
import { DecideForm } from './decide-form';

/** The statuses worth filtering by, in the order an operator moves through them. */
const FILTERS = [
  { value: 'in_review', label: 'Waiting' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: '', label: 'All' },
] as const;

/**
 * The KYC review queue.
 *
 * Defaults to `in_review` — the work — rather than to everything, because a reviewer opening this
 * page wants the decisions they still owe, not a history they have already made.
 *
 * How long each person has been waiting is given prominence and turns amber then red as it
 * approaches the 24 hours the app promises them. That number is the commitment; a timestamp alone
 * would make the operator do the arithmetic every time.
 */
export default async function KycQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const active = status ?? 'in_review';

  let rows: QueuedVerification[] = [];
  let error: string | null = null;
  try {
    rows = await listVerifications(active);
  } catch (e) {
    error = e instanceof BackendError ? e.message : 'Could not load the queue.';
  }

  return (
    <>
      <div className="ops-head">
        <h1>Verifications</h1>
        <p>
          Every submission is reviewed by a person. Nothing here contains a name or a document — the
          app checks those on the device and never uploads them, so you are deciding on the record,
          not on the paperwork.
        </p>
      </div>

      <div className="ops-filters">
        {FILTERS.map((filter) => (
          <Link
            key={filter.label}
            href={filter.value ? `/ops/kyc?status=${filter.value}` : '/ops/kyc?status='}
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
              This is a connection problem, not an empty queue — work may still be waiting.
            </p>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="ops-empty">
          <div className="ops-empty-mark">
            <CheckIcon size={20} />
          </div>
          <h3>{active === 'in_review' ? 'The queue is clear' : 'Nothing to show'}</h3>
          <p>
            {active === 'in_review'
              ? 'Every submission has been decided. New ones appear here as they arrive.'
              : 'No verifications match this filter yet.'}
          </p>
        </div>
      ) : (
        <div className="ops-list">
          {rows.map((row) => (
            <QueueRow key={row.userId} row={row} />
          ))}
        </div>
      )}

      {rows.length > 0 && active === 'in_review' ? (
        <div className="ops-note">
          <InfoIcon />
          <span>
            A rejection reason is not a formality: it decides the message the person sees, and four
            of them (sanctions, duplicate identity, under age, altered document) are{' '}
            <strong>terminal</strong> — that person can never resubmit. The button says so before
            you press it.
          </span>
        </div>
      ) : null}
    </>
  );
}

function QueueRow({ row }: { row: QueuedVerification }) {
  const decidable = row.status === 'in_review' || row.status === 'pending';
  const age = waitedFor(row.updatedAt);

  return (
    <div className="ops-row">
      <div className="ops-row-main">
        <div className="ops-row-title">
          <span className="ops-id" title={row.userId}>
            {shorten(row.userId)}
          </span>
        </div>
        <div className="ops-meta">
          Tier {row.tier} · submitted {formatDate(row.createdAt)}
          {decidable ? (
            <>
              {' · waiting '}
              <span className={age.className}>{age.label}</span>
            </>
          ) : (
            ` · ${row.status === 'approved' ? 'approved' : 'decided'} ${age.label} ago`
          )}
          {row.reasonCode ? ` · ${row.reasonCode.replace(/_/g, ' ')}` : ''}
        </div>
      </div>

      <div className="ops-actions">
        <span className={`pill ${pillClass(row.status)}`}>{row.status.replace('_', ' ')}</span>
        {decidable ? <DecideForm userId={row.userId} /> : null}
      </div>
    </div>
  );
}

function pillClass(status: string): string {
  if (status === 'approved') return 'pill-approved';
  if (status === 'rejected') return 'pill-rejected';
  if (status === 'in_review' || status === 'pending') return 'pill-review';
  return '';
}

/** A 64-character hash is unreadable in a row; the ends are enough to tell two apart. */
function shorten(userId: string): string {
  return userId.length <= 20 ? userId : `${userId.slice(0, 10)}…${userId.slice(-6)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * How long this person has been waiting, coloured against the promise made to them.
 *
 * Amber past 12 hours, red past 24 — the point at which the app has told them to chase us.
 */
function waitedFor(iso: string): { label: string; className: string } {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  const hours = minutes / 60;

  let label: string;
  if (minutes < 1) label = 'moments';
  else if (minutes < 60) label = `${minutes} min`;
  else if (hours < 24) label = `${Math.floor(hours)} hour${Math.floor(hours) === 1 ? '' : 's'}`;
  else {
    const days = Math.floor(hours / 24);
    label = `${days} day${days === 1 ? '' : 's'}`;
  }

  const className = hours >= 24 ? 'ops-age-late' : hours >= 12 ? 'ops-age-warn' : '';
  return { label, className };
}
