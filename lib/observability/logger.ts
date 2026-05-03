/**
 * Structured logger for the web/dispatcher services.
 *
 * Decision: existing call sites (console.log({ event, ... })) are NOT migrated
 * here — they already emit JSON-shaped objects and are grep-friendly for the
 * canonical-event audit. This module makes pino + Sentry available for NEW
 * code and future gradual migration. Forcing migration of 30+ existing call
 * sites would be pure churn with no functional benefit.
 *
 * Sentry is initialised ONLY in production (NODE_ENV === 'production' AND
 * SENTRY_DSN is set) so dev/test environments never crash on a missing DSN.
 *
 * Service tag: reads SERVICE_NAME env (defaults 'web'). The dispatcher script
 * sets SERVICE_NAME=dispatcher before starting.
 */

import { createRequire } from 'node:module'

// ─── pino (optional — falls back to console if not installed) ──────────────

type PinoLogger = {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  error: (obj: object, msg?: string) => void
  debug: (obj: object, msg?: string) => void
}

function buildPinoLogger(): PinoLogger | null {
  try {
    // Dynamic require so the module still loads when pino is absent (e.g.
    // during tests that don't install optional deps).
    const require = createRequire(import.meta.url)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // pino exports itself as a callable; the default export is the function.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pino = require('pino') as any
    const isProd = process.env.NODE_ENV === 'production'
    return pino({
      level: process.env.LOG_LEVEL ?? 'info',
      // In dev use pino-pretty if available; in prod emit raw JSON.
      ...(isProd ? {} : { transport: { target: 'pino-pretty' } }),
    })
  } catch {
    return null
  }
}

// ─── Sentry init ───────────────────────────────────────────────────────────

function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  if (process.env.NODE_ENV !== 'production' || !dsn) return

  try {
    const require = createRequire(import.meta.url)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require('@sentry/nextjs') as typeof import('@sentry/nextjs')
    const serviceName = (process.env.SERVICE_NAME ?? 'web') as
      | 'web'
      | 'dispatcher'
      | 'worker'
    Sentry.init({
      dsn,
      initialScope: {
        tags: { service: serviceName },
      },
    })
  } catch {
    // Sentry SDK not installed — silently skip.
  }
}

initSentry()

// ─── Exported logger ──────────────────────────────────────────────────────

const pinoLogger = buildPinoLogger()

const consoleFallback: PinoLogger = {
  info: (obj, msg) => console.log({ ...obj, ...(msg ? { msg } : {}) }),
  warn: (obj, msg) => console.warn({ ...obj, ...(msg ? { msg } : {}) }),
  error: (obj, msg) => console.error({ ...obj, ...(msg ? { msg } : {}) }),
  debug: (obj, msg) => console.debug({ ...obj, ...(msg ? { msg } : {}) }),
}

export const logger: PinoLogger = pinoLogger ?? consoleFallback
