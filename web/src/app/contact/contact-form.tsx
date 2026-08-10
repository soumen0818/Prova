'use client';

import { MAX_CONTACT_MESSAGE_CHARS } from '@prova/shared';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { CONTACT_EMAIL } from '@/lib/site';

import { submitContact, type ContactState } from './actions';

/** Mirrors the server's rule. Kept permissive on purpose — see the note in actions.ts. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const MIN_MESSAGE = 10;

/**
 * Name, email, message — and nothing else, because nothing else is needed to answer someone.
 *
 * Validation shows only after a field has been left, not while it is being typed: telling somebody
 * their email is invalid on the second keystroke is technically true and quietly hostile. Every
 * rule here is enforced again on the server, which is the actual control.
 */
export function ContactForm() {
  const [state, formAction] = useActionState<ContactState, FormData>(submitContact, {});

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const chars = [...message].length;
  const overLimit = chars > MAX_CONTACT_MESSAGE_CHARS;

  const localError = (field: 'name' | 'email' | 'message'): string => {
    if (!touched[field]) return '';
    if (field === 'name') {
      if (!name.trim()) return 'Please tell us your name.';
      if (name.trim().length < 2) return 'That name looks too short.';
    }
    if (field === 'email') {
      if (!email.trim()) return 'Please give us an email address.';
      if (!EMAIL_SHAPE.test(email.trim())) return 'That email address does not look right.';
    }
    if (field === 'message') {
      if (!message.trim()) return 'Please write a message.';
      if (message.trim().length < MIN_MESSAGE)
        return 'Please tell us a little more so we can help.';
      if (overLimit) return 'That message is too long.';
    }
    return '';
  };

  // The server tells us which field it rejected, so its message lands under that field rather than
  // in a general banner the reader has to map back to an input themselves.
  const errorFor = (field: 'name' | 'email' | 'message'): string =>
    localError(field) || (state.field === field ? (state.error ?? '') : '');

  const generalError = state.error && !state.field ? state.error : '';

  if (state.ok) {
    return (
      <div className="card form-card form-done">
        <div className="form-tick" aria-hidden="true">
          ✓
        </div>
        <h3>Message sent</h3>
        <p>
          Thanks — we have it. You will get a reply at the address you gave us, usually within 24
          hours.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="card form-card" noValidate>
      <p className="form-required-note">
        All fields are required. We reply by email, usually within 24 hours.
      </p>

      <div className="field">
        <label htmlFor="name">
          Your name <span className="req">required</span>
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          aria-invalid={!!errorFor('name')}
          className={errorFor('name') ? 'field-invalid' : undefined}
        />
        {errorFor('name') ? <span className="field-error">{errorFor('name')}</span> : null}
      </div>

      <div className="field">
        <label htmlFor="email">
          Email address <span className="req">required</span>
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@gmail.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
          aria-invalid={!!errorFor('email')}
          className={errorFor('email') ? 'field-invalid' : undefined}
        />
        {errorFor('email') ? (
          <span className="field-error">{errorFor('email')}</span>
        ) : (
          <span className="field-hint">This is where we reply, so please check it.</span>
        )}
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="message">
            Message <span className="req">required</span>
          </label>
          {/*
            Always visible, not just once the limit is close. A limit nobody can see until they hit
            it is a limit that only ever appears as a rejection — and somebody who has just written
            a long message is the last person who should discover it then.
          */}
          <span className={`field-count ${overLimit ? 'field-count-over' : ''}`} aria-live="polite">
            {chars.toLocaleString()} / {MAX_CONTACT_MESSAGE_CHARS.toLocaleString()}
          </span>
        </div>
        <textarea
          id="message"
          name="message"
          rows={6}
          placeholder="How can we help?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, message: true }))}
          aria-invalid={!!errorFor('message')}
          className={errorFor('message') ? 'field-invalid' : undefined}
        />
        {errorFor('message') ? <span className="field-error">{errorFor('message')}</span> : null}
      </div>

      {/*
        Honeypot. Positioned off-screen rather than `display: none`, because some bots skip hidden
        fields but almost all of them fill anything they can reach. A real person never sees it,
        and `tabIndex={-1}` keeps it out of keyboard navigation too.
      */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="company">Company</label>
        <input id="company" name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {generalError ? <p className="form-error">{generalError}</p> : null}

      <SubmitButton disabled={overLimit} />

      <p className="form-note">
        We only use this to reply to you. Prefer email? Write to{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </form>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary form-submit" disabled={pending || disabled}>
      {pending ? 'Sending…' : 'Send message'}
    </button>
  );
}
