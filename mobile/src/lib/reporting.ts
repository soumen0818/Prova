/**
 * Central error/event reporting. Today it logs; it's the single place to wire a crash reporter.
 *
 * To enable Sentry later (needs `@sentry/react-native` + `EXPO_PUBLIC_SENTRY_DSN` + a native
 * rebuild): call `Sentry.init({ dsn: env.sentryDsn })` in `initReporting`, and forward to
 * `Sentry.captureException` in `captureError`.
 */
import { env } from '@/config/env';

let started = false;

export function initReporting(): void {
  if (started) return;
  started = true;
  // if (env.sentryDsn) Sentry.init({ dsn: env.sentryDsn, enableNative: true });
  if (env.sentryDsn) {
    console.info('[prova] reporting configured (DSN present)');
  }
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  console.error('[prova] error', error, context ?? {});
  // if (env.sentryDsn) Sentry.captureException(error, { extra: context });
}
