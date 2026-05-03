/**
 * CLI entry point for the dispatcher runner.
 *
 * Usage: pnpm tsx scripts/run-dispatcher.ts
 *
 * Env vars (all optional):
 *   WORKER_ID                        — defaults to worker-<hostname>-<pid>
 *   WORKER_DISPATCHER_CONCURRENCY    — defaults to 2
 *   WORKER_DISPATCHER_POLL_MS        — defaults to 2000
 */

import { hostname } from 'node:os'
import { runDispatcher } from '@/lib/worker/runner'

const workerId = process.env.WORKER_ID ?? `worker-${hostname()}-${process.pid}`

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn({ event: 'worker.runner.bad_env', name, raw, fallback })
    return fallback
  }
  return n
}

const concurrency = parseIntEnv('WORKER_DISPATCHER_CONCURRENCY', 2)
const pollIntervalMs = parseIntEnv('WORKER_DISPATCHER_POLL_MS', 2000)

const runner = runDispatcher({ workerId, concurrency, pollIntervalMs })

async function shutdown() {
  await runner.shutdown()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

process.on('uncaughtException', (err) => {
  console.error({ event: 'worker.runner.uncaught_exception', err: err.message, stack: err.stack })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error({ event: 'worker.runner.unhandled_rejection', reason })
  process.exit(1)
})

runner.joined
  .then(() => {
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error({ event: 'worker.runner.fatal', err })
    process.exit(1)
  })
