'use client';

import Image from 'next/image';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { signIn, type ActionState } from '@/app/ops/actions';

/**
 * The console's sign-in form.
 *
 * The page gives nothing away — no explanation of what is behind it, no hint that it is a
 * compliance console. Somebody who belongs here already knows what this is, and the link to it is
 * now public, so the page itself should not advertise what it guards.
 */
export function LoginForm() {
  const [state, formAction] = useActionState<ActionState, FormData>(signIn, {});

  return (
    <main className="ops-login">
      <form className="ops-login-card" action={formAction}>
        <Image src="/brand/symbol.png" alt="" width={40} height={40} className="ops-login-mark" />

        <h1>Sign in</h1>
        <p>This area is for the Prova team.</p>

        <div className="ops-field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            className="ops-input"
            autoComplete="username"
            autoFocus
            required
          />
        </div>

        <div className="ops-field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            className="ops-input"
            autoComplete="current-password"
            required
          />
        </div>

        {state.error ? <p className="ops-error">{state.error}</p> : null}

        <SubmitButton />
      </form>
    </main>
  );
}

function SubmitButton() {
  // `useFormStatus` has to live in a child of the form — it reads the pending state of the nearest
  // enclosing one, so it always returns false if called in the component that renders the <form>.
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="ops-btn ops-btn-primary" disabled={pending}>
      {pending ? 'Checking…' : 'Continue'}
    </button>
  );
}
