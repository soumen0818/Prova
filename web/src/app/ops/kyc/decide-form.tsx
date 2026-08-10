'use client';

import { ReasonCode, retryableReason } from '@prova/shared';
import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { decide, type ActionState } from '../actions';

/**
 * Rejection reasons an operator can pick, worded as a person would say them.
 *
 * The values are the machine codes the app already understands — they decide the message the user
 * sees and, for the terminal ones, whether they are allowed to try again at all. Getting one wrong
 * either strands somebody who could have retried, or invites a resubmission that must not happen.
 */
const REASONS: { value: string; label: string }[] = [
  { value: ReasonCode.DOCUMENT_UNREADABLE, label: 'Document is unreadable' },
  { value: ReasonCode.DOCUMENT_EXPIRED, label: 'Document has expired' },
  { value: ReasonCode.FACE_MISMATCH, label: 'Selfie does not match the document' },
  { value: ReasonCode.LIVENESS_FAILED, label: 'Liveness check failed' },
  { value: ReasonCode.DOCUMENT_TAMPERED, label: 'Document appears altered' },
  { value: ReasonCode.DUPLICATE_IDENTITY, label: 'Duplicate identity' },
  { value: ReasonCode.UNDERAGE, label: 'Under age' },
  { value: ReasonCode.SANCTIONS_HIT, label: 'Sanctions match' },
];

/** Approve or reject one submission. */
export function DecideForm({ userId }: { userId: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(decide, {});
  const [reason, setReason] = useState(REASONS[0].value);
  const [confirming, setConfirming] = useState(false);

  const terminal = !retryableReason(reason);

  // Changing the reason cancels a pending confirmation. Otherwise a click armed for "unreadable
  // document" could be completed against "sanctions match", which is a permanent ban.
  useEffect(() => setConfirming(false), [reason]);

  return (
    <form action={formAction} className="ops-actions">
      <input type="hidden" name="userId" value={userId} />

      <select
        name="reasonCode"
        className="ops-select"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-label="Rejection reason">
        {REASONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>

      <Buttons terminal={terminal} confirming={confirming} onArm={() => setConfirming(true)} />

      {state.error ? <span className="ops-error">{state.error}</span> : null}
    </form>
  );
}

function Buttons({
  terminal,
  confirming,
  onArm,
}: {
  terminal: boolean;
  confirming: boolean;
  onArm: () => void;
}) {
  // `useFormStatus` has to live in a child of the form — it reads the pending state of the nearest
  // enclosing one, so it always returns false if called in the component that renders the <form>.
  const { pending } = useFormStatus();

  return (
    <>
      <button
        type="submit"
        name="decision"
        value="approved"
        className="ops-btn ops-btn-approve"
        disabled={pending}>
        {pending ? 'Saving…' : 'Approve'}
      </button>

      {/*
        A terminal rejection permanently bars this person from ever resubmitting, and it cannot be
        undone from this console. One stray click must not be able to do that, so terminal reasons
        take two: the first arms the button, the second commits.

        This is ONE button that cancels its own submit, deliberately — not two buttons swapped by a
        condition. Rendering `type="button"` and `type="submit"` from a ternary reconciles to the
        same DOM node, so React only flips the `type` attribute; the click handler runs, the
        attribute becomes "submit", and the browser then performs the default action on that same
        node. The result was a "confirmation" that armed and fired in a single click, recording
        permanent sanctions rejections. `preventDefault` on a stable submit button cannot fail that
        way.
      */}
      <button
        type="submit"
        name="decision"
        value="rejected"
        className="ops-btn ops-btn-reject"
        disabled={pending}
        onClick={(event) => {
          if (terminal && !confirming) {
            event.preventDefault();
            onArm();
          }
        }}
        title={
          terminal
            ? 'This person will never be able to try again.'
            : 'They will be able to correct this and resubmit.'
        }>
        {pending
          ? 'Saving…'
          : !terminal
            ? 'Reject'
            : confirming
              ? 'Confirm — this is permanent'
              : 'Reject (final)'}
      </button>
    </>
  );
}
