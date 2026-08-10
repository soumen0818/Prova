import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/session';

import { LoginForm } from './login-form';
import '@/app/ops/ops.css';

export const metadata: Metadata = {
  title: 'Sign in',
  // Belt-and-braces with the X-Robots-Tag header and robots.ts: a staff console has no business in
  // anyone's search results.
  robots: { index: false, follow: false },
};

/**
 * The console sign-in page.
 *
 * It lives in the `(ops-login)` route group rather than under `app/ops/` so that the gate in
 * `app/ops/layout.tsx` does not apply to it. Nested under that layout, the sign-in page was itself
 * blocked by the "you must sign in" check — a locked door with the key on the inside. The route
 * group changes which layout wraps it without changing the URL, which stays `/ops/login`.
 */
export default async function LoginPage() {
  // Already signed in — send them where they were going rather than making them log in twice.
  if (await isSignedIn()) redirect('/ops');
  return <LoginForm />;
}
