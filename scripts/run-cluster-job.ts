/**
 * CLI entry point for the per-event clustering job.
 *
 * Runs runClusterJob() immediately, then on every CLUSTER_INTERVAL_MS interval.
 * SIGTERM/SIGINT trigger a clean shutdown after the current run completes
 * (no new runs are started; the in-flight run finishes its event transactions).
 *
 * Env vars (all optional):
 *   CLUSTER_INTERVAL_MS   — polling interval in ms (default 120_000 = 2 min)
 *   MATCH_MAX_DISTANCE    — cosine distance threshold (default 0.582)
 */

import { runClusterJob } from '@/lib/worker/cluster'

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.warn({ event: 'worker.cluster.bad_env', name, raw, fallback })
    return fallback
  }
  return n
}

const intervalMs = parseIntEnv('CLUSTER_INTERVAL_MS', 120_000)

let shuttingDown = false
let inFlight: Promise<void> | null = null
let intervalHandle: ReturnType<typeof setInterval> | null = null
let exitCode = 0

async function tick() {
  if (shuttingDown) return
  try {
    await runClusterJob()
  } catch (_err) {
    // runClusterJob already logged worker.cluster.failed with stack. Mark
    // for non-zero exit so a process supervisor (or cron) sees it.
    exitCode = 1
    shuttingDown = true
  }
}

async function start() {
  // Run once immediately, then on each interval.
  inFlight = tick()
  await inFlight
  inFlight = null

  if (shuttingDown) return

  intervalHandle = setInterval(() => {
    if (shuttingDown || inFlight != null) return
    inFlight = tick().finally(() => {
      inFlight = null
    })
  }, intervalMs)
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log({ event: 'worker.cluster.shutting_down' })
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  // Wait for in-flight run to finish so we don't terminate mid-transaction.
  if (inFlight) {
    try {
      await inFlight
    } catch (_err) {
      // Already logged by runClusterJob.
    }
  }
  process.exit(exitCode)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

process.on('uncaughtException', (err) => {
  console.error({
    event: 'worker.cluster.uncaught_exception',
    error: err.message,
    stack: err.stack,
  })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error({ event: 'worker.cluster.unhandled_rejection', reason })
  process.exit(1)
})

start().catch((err: unknown) => {
  console.error({
    event: 'worker.cluster.fatal',
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  process.exit(1)
})
