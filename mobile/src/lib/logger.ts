/**
 * Minimal logging abstraction with a stable interface, ready to forward to Sentry (or another
 * crash/observability backend) without touching call sites.
 *
 * Wire the real backend later inside `captureError` / the `log` switch — Phase 0 keeps it to the
 * console so we don't pull in an SDK before there's a DSN. NEVER log secrets, amounts, or PII
 * (see proposal.md §4.2): those must not leave the device.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

function log(level: Level, message: string, context?: Record<string, unknown>): void {
  // In production this is where we'd forward to Sentry breadcrumbs/messages.
  if (!isDev && level === 'debug') return;

  const line = `[prova:${level}] ${message}`;
  switch (level) {
    case 'error':
      console.error(line, context ?? '');
      break;
    case 'warn':
      console.warn(line, context ?? '');
      break;
    default:
      console.log(line, context ?? '');
  }
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => log('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => log('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => log('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => log('error', message, context),
  /** Report a caught exception. Hook Sentry.captureException here later. */
  captureError: (error: unknown, context?: Record<string, unknown>) => {
    const message = error instanceof Error ? error.message : String(error);
    log('error', message, context);
  },
};
