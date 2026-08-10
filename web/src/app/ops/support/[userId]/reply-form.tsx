'use client';

import { MAX_SUPPORT_BODY_CHARS } from '@prova/shared';
import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';

import { reply, setThreadStatus, type ActionState } from '../../actions';

/** Write back to the person. */
export function ReplyForm({ userId }: { userId: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(reply, {});
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the box once the reply has actually been recorded. Clearing optimistically would throw
  // away what was typed if the send failed, which is worse than a moment of stale text.
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} action={formAction} className="ops-card">
      <input type="hidden" name="userId" value={userId} />
      <label htmlFor="reply" className="ops-reply-label">
        Your reply
      </label>
      <textarea
        id="reply"
        name="body"
        className="ops-textarea"
        placeholder="Write a reply…"
        maxLength={MAX_SUPPORT_BODY_CHARS}
        required
      />
      {state.error ? <p className="ops-error">{state.error}</p> : null}
      <div className="ops-reply-foot">
        <span className="ops-reply-hint">
          They see this as a message from “the Prova team”, not from a named person.
        </span>
        <SendButton />
      </div>
    </form>
  );
}

function SendButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="ops-btn ops-btn-primary" disabled={pending}>
      {pending ? 'Sending…' : 'Send reply'}
    </button>
  );
}

/**
 * File the conversation, or reopen it.
 *
 * Closing is filing, not locking: the next message from the user reopens the thread automatically,
 * so this cannot be used to stop somebody reaching us.
 */
export function StatusToggle({ userId, status }: { userId: string; status: string }) {
  const [state, formAction] = useActionState<ActionState, FormData>(setThreadStatus, {});
  const next = status === 'closed' ? 'open' : 'closed';

  return (
    <form action={formAction}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="status" value={next} />
      <button type="submit" className="ops-btn">
        {next === 'closed' ? 'Mark as resolved' : 'Reopen conversation'}
      </button>
      {state.error ? <p className="ops-error">{state.error}</p> : null}
    </form>
  );
}
