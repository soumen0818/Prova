'use server';

import { MAX_CONTACT_MESSAGE_CHARS } from '@prova/shared';

import { clientIp, rateLimit } from '@/lib/rate-limit';
import { CONTACT_EMAIL } from '@/lib/site';

/**
 * The contact form's submit handler.
 *
 * ## Where the message goes
 *
 * Into the same support inbox the app's chat writes to, so a message from the website and a message
 * from the app land in one place and neither gets lost. Website enquiries have no wallet, so they
 * are filed under a synthetic thread id derived from the sender's email — the same person writing
 * twice continues one conversation instead of starting a second.
 *
 * ## Why it does not send email
 *
 * A mail send needs SMTP credentials on the web server, which is a second place for a secret to
 * leak and a second thing to be down. The backend already has an inbox and the console already
 * reads it; adding an email path would be a parallel system to maintain for the same message.
 * Replies go out from the address below, by hand, which is the honest shape of a one-person team.
 *
 * ## Everything here is checked twice
 *
 * The form validates as you type, and every rule is enforced again below. Client-side validation is
 * a courtesy to the person filling in the form; it is not a control, because anyone can post to
 * this endpoint directly without ever loading the page.
 */

export interface ContactState {
  error?: string;
  ok?: boolean;
  /** Which field to highlight. Lets the form put the error where the mistake is. */
  field?: 'name' | 'email' | 'message';
}

const MIN_NAME = 2;
const MAX_NAME = 120;
const MIN_MESSAGE = 10;

/**
 * Submissions allowed per address, and per email, inside the window.
 *
 * Three in fifteen minutes is far more than a genuine person needs — they write once and wait for a
 * reply — while a script looping the form hits it within seconds. Both keys are checked: the IP
 * catches one machine sending many messages, and the email catches a botnet with many addresses
 * pointing at one inbox.
 */
const MAX_PER_WINDOW = 3;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Deliberately permissive, and intentionally not a "real" RFC 5322 pattern.
 *
 * The only thing worth checking here is that a reply could plausibly be delivered — a local part, an
 * @, a domain with a dot. Stricter patterns are famous for rejecting valid addresses (plus tags,
 * new TLDs, apostrophes), and every one of those is a person we would silently refuse to hear from.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export async function submitContact(
  _prev: ContactState,
  formData: FormData,
): Promise<ContactState> {
  const name = String(formData.get('name') ?? '').trim();
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const message = String(formData.get('message') ?? '').trim();
  // Bots fill in every field they find, including one positioned off-screen that no person sees.
  const trap = String(formData.get('company') ?? '');

  // --- Field rules -------------------------------------------------------

  if (!name) return { error: 'Please tell us your name.', field: 'name' };
  if (name.length < MIN_NAME) return { error: 'That name looks too short.', field: 'name' };
  if (name.length > MAX_NAME) return { error: 'That name is too long.', field: 'name' };

  if (!email) return { error: 'Please give us an email address.', field: 'email' };
  if (!EMAIL_SHAPE.test(email)) {
    return { error: 'That email address does not look right.', field: 'email' };
  }

  if (!message) return { error: 'Please write a message.', field: 'message' };
  if (message.length < MIN_MESSAGE) {
    return { error: 'Please tell us a little more so we can help.', field: 'message' };
  }
  // Counted in characters the person typed. Emoji and Indic scripts cost more than one byte each,
  // so a byte limit would cut a message in Hindi shorter than the same message in English.
  if ([...message].length > MAX_CONTACT_MESSAGE_CHARS) {
    return {
      error: `Please keep your message under ${MAX_CONTACT_MESSAGE_CHARS.toLocaleString()} characters.`,
      field: 'message',
    };
  }

  // --- Abuse controls ----------------------------------------------------

  // A filled honeypot succeeds silently. Showing an error would tell a scripted submitter exactly
  // which field gave it away, and it would simply stop filling that one.
  if (trap) return { ok: true };

  const ip = await clientIp();
  const byIp = rateLimit(`contact:ip:${ip}`, MAX_PER_WINDOW, WINDOW_MS);
  const byEmail = rateLimit(`contact:email:${email}`, MAX_PER_WINDOW, WINDOW_MS);

  if (!byIp.allowed || !byEmail.allowed) {
    const wait = Math.max(byIp.retryAfterSeconds, byEmail.retryAfterSeconds);
    return {
      error: `You have sent us a few messages already — we have them. Please wait ${describeWait(wait)} before sending another, or email ${CONTACT_EMAIL} directly.`,
    };
  }

  // --- Deliver -----------------------------------------------------------

  try {
    await deliver({ name, email, message });
  } catch {
    // The reader still has a way through, and it is named rather than implied.
    return { error: `Could not send that. Please email us directly at ${CONTACT_EMAIL}.` };
  }
  return { ok: true };
}

function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Post the enquiry into the backend's support inbox. */
async function deliver(enquiry: { name: string; email: string; message: string }): Promise<void> {
  const { createHash } = await import('node:crypto');
  // The support API is addressed by a 32-byte hex id. A website enquiry has no wallet, so one is
  // derived from the email — stable, so a follow-up joins the same thread, and one-way, so the
  // inbox holds no address it was not given in the message body.
  const threadId = createHash('sha256').update(`web-contact:${enquiry.email}`).digest('hex');

  const body = [
    `Website enquiry`,
    `From: ${enquiry.name} <${enquiry.email}>`,
    ``,
    enquiry.message,
  ].join('\n');

  const base = (process.env.PROVA_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const res = await fetch(`${base}/support/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`support inbox returned ${res.status}`);
}
