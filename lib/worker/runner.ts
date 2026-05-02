import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { processOneJob } from './dispatcher'

export interface RunDispatcherOpts {
  /** Worker identifier, embedded in claims */
  workerId: string
  /** Number of concurrent polling loops */
  concurrency?: number
  /** Milliseconds to sleep when idle (no job claimed) */
  pollIntervalMs?: number
  /** Milliseconds between watchdog ticks */
  watchdogIntervalMs?: number
  /** Seconds after which a claimed job is considered stuck */
  watchdogStaleSec?: number
}

export interface DispatcherRunner {
  /** Signal graceful shutdown. Returns a promise that resolves when shutdown is complete. */
  shutdown: () => Promise<void>
  /** Resolves when all loops have exited */
  joined: Promise<void>
}

type ReclaimedRow = {
  id: string
  claimed_by: string | null
}

/**
 * Watchdog: reset stuck `claimed` jobs back to `queued`.
 *
 * Called on a fixed interval. Only emits `worker.watchdog.reclaimed` when N > 0
 * (quiet idle — log only when something happened).
 */
async function runWatchdog(staleSec: number): Promise<void> {
  const result = (await db.execute(sql`
    UPDATE photo_jobs
    SET
      state      = 'queued',
      claimed_at = NULL,
      claimed_by = NULL,
      updated_at = now()
    WHERE state = 'claimed'
      AND claimed_at < now() - make_interval(secs => ${staleSec})
    RETURNING id, claimed_by
  `)) as unknown as ReclaimedRow[]

  const rows = Array.from(result)
  const n = rows.length

  if (n > 0) {
    console.warn({
      event: 'worker.watchdog.reclaimed',
      n,
      jobs: rows.map((r) => ({ id: r.id, previousClaimedBy: r.claimed_by })),
    })
  }
  // Quiet idle: no log when n === 0
}

/**
 * Runs the dispatcher: N concurrent polling loops + watchdog interval.
 *
 * Log cadence:
 *   - worker.runner.started   once on startup
 *   - worker.runner.shutting_down  once when shutdown() is called
 *   - worker.runner.idle      debug, emitted on first idle after a non-idle period
 *     (transition-based: silent during sustained idle, logs when activity → idle)
 *   - worker.watchdog.reclaimed  warn, only when N > 0
 */
export function runDispatcher(opts: RunDispatcherOpts): DispatcherRunner {
  const {
    workerId,
    concurrency = 2,
    pollIntervalMs = 2000,
    watchdogIntervalMs = 60_000,
    watchdogStaleSec = 120,
  } = opts

  let shuttingDown = false
  // Set of pending sleep timers so shutdown() can wake them immediately.
  const pendingSleeps = new Set<() => void>()

  // shutdownResolve is called when all loops exit
  let shutdownResolve!: () => void
  let shutdownReject!: (err: unknown) => void

  const joined = new Promise<void>((resolve, reject) => {
    shutdownResolve = resolve
    shutdownReject = reject
  })

  console.log({ event: 'worker.runner.started', workerId, concurrency, pollIntervalMs })

  /**
   * Single polling loop. Tracks wasIdle to emit idle log only on transitions.
   */
  async function pollLoop(loopId: number): Promise<void> {
    // null = unknown (first poll); true = was idle last iter; false = was active
    let wasIdle: boolean | null = null

    while (!shuttingDown) {
      let result: Awaited<ReturnType<typeof processOneJob>>

      try {
        result = await processOneJob(`${workerId}-loop${loopId}`)
      } catch (err) {
        // processOneJob handles its own errors internally; this is a safety net
        console.error({ event: 'worker.runner.unhandled_error', loopId, err })
        result = null
      }

      if (shuttingDown) {
        // If shutdown was signalled while we were processing, exit now.
        break
      }

      if (result === null) {
        // Idle: no job available or race loss
        // Log on first idle (transition from unknown or active → idle)
        if (wasIdle !== true) {
          console.debug({ event: 'worker.runner.idle', loopId, workerId })
          wasIdle = true
        }
        // Sleep before next poll (abortable on shutdown)
        await abortableSleep(pollIntervalMs, pendingSleeps)
      } else {
        // Got a job — reset idle tracking
        wasIdle = false
      }
    }
  }

  // Start all loops
  const loopPromises: Promise<void>[] = []
  for (let i = 0; i < concurrency; i++) {
    loopPromises.push(pollLoop(i))
  }

  // Start watchdog
  const watchdogTimer = setInterval(() => {
    runWatchdog(watchdogStaleSec).catch((err) => {
      console.error({ event: 'worker.watchdog.error', err })
    })
  }, watchdogIntervalMs)

  // Wait for all loops then resolve `joined`
  Promise.all(loopPromises)
    .then(() => {
      clearInterval(watchdogTimer)
      shutdownResolve()
    })
    .catch((err) => {
      clearInterval(watchdogTimer)
      shutdownReject(err)
    })

  let shutdownCalled = false

  async function shutdown(): Promise<void> {
    if (shutdownCalled) return
    shutdownCalled = true

    console.log({ event: 'worker.runner.shutting_down', workerId })
    shuttingDown = true

    // Wake any loops sleeping between polls so they observe the flag immediately.
    for (const wake of pendingSleeps) wake()
    pendingSleeps.clear()

    // Wait for loops to drain (they check shuttingDown after each processOneJob)
    await joined
  }

  return { shutdown, joined }
}

/**
 * Sleep for `ms` or until cancelled by calling the registered wake-up.
 * Adds its wake-up function to `pending` while sleeping; removes on resolve.
 */
function abortableSleep(ms: number, pending: Set<() => void>): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const wake = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      pending.delete(wake)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    pending.add(wake)
  })
}
