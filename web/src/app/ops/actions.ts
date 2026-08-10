'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import * as backend from '@/lib/backend';
import { createSession, credentialsMatch, destroySession, isSignedIn } from '@/lib/session';

/**
 * Server actions for the operator console.
 *
 * Every action re-checks the session itself rather than trusting that the page which rendered the
 * form was protected. A server action is a POST endpoint with a public URL — anyone can call it
 * directly, so "the layout already checked" is not a check.
 */

/** What a form action hands back to the client for rendering. */
export interface ActionState {
  error?: string;
  ok?: boolean;
}

async function requireSession(): Promise<void> {
  if (!(await isSignedIn())) {
    redirect('/ops/login');
  }
}

/** Sign in with the operator email and password. */
export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  if (!email || !password) return { error: 'Enter your email and password.' };

  if (!credentialsMatch(email, password)) {
    // One message for every failure — wrong address, wrong password, or nothing configured at all.
    // Saying which was wrong tells someone guessing that the other half was right, and saying
    // "not configured" tells them the console is unarmed.
    return { error: 'Those details are not correct.' };
  }
  await createSession();
  redirect('/ops');
}

/** Sign out. */
export async function signOut(): Promise<void> {
  await destroySession();
  redirect('/ops/login');
}

/** Approve or reject a verification. */
export async function decide(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();

  const userId = String(formData.get('userId') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const reasonCode = String(formData.get('reasonCode') ?? '').trim();

  if (decision !== 'approved' && decision !== 'rejected') {
    return { error: 'Unknown decision.' };
  }
  // A rejection with no reason is unusable later: it is the field the audit trail relies on to
  // explain why somebody was turned down, and it decides whether they may try again.
  if (decision === 'rejected' && !reasonCode) {
    return { error: 'Choose a reason for the rejection.' };
  }

  try {
    await backend.decideVerification(userId, decision, reasonCode || undefined);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not record the decision.' };
  }

  revalidatePath('/ops');
  revalidatePath('/ops/kyc');
  return { ok: true };
}

/** Reply to a support conversation as the team. */
export async function reply(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession();

  const userId = String(formData.get('userId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return { error: 'Write a message first.' };

  try {
    await backend.replyToThread(userId, body);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not send the reply.' };
  }

  revalidatePath(`/ops/support/${userId}`);
  revalidatePath('/ops/support');
  return { ok: true };
}

/** File a conversation as open or closed. */
export async function setThreadStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireSession();

  const userId = String(formData.get('userId') ?? '');
  const status = String(formData.get('status') ?? '');
  if (status !== 'open' && status !== 'closed') return { error: 'Unknown status.' };

  try {
    await backend.setThreadStatus(userId, status);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not update the conversation.' };
  }

  revalidatePath(`/ops/support/${userId}`);
  revalidatePath('/ops/support');
  return { ok: true };
}
