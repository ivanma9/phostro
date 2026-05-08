import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { processOneJob } from '@/lib/worker/dispatcher'

export const runtime = 'nodejs'
export const maxDuration = 60

// Leave headroom under maxDuration so an in-flight processOneJob can complete
// before the function is killed. Worker calls average ~1s; allow ~10s slack.
const TIME_BUDGET_MS = 50_000

/**
 * Cron-driven queue drain. Vercel hits this every minute (see vercel.json) and
 * the handler claims jobs in a loop until either the queue is empty or the
 * time budget is exhausted. Substitutes for a long-running Node dispatcher.
 *
 * Auth: Vercel injects `Authorization: Bearer ${CRON_SECRET}` on cron requests.
 * Without that header (or with a mismatched secret) the handler 401s, so the
 * endpoint is not externally callable. CRON_SECRET must be set in env for any
 * environment that should drain.
 */
export async function GET(req: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron_not_configured' }, { status: 503 })
  }
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const start = Date.now()
  const workerId = `cron-drain-${randomUUID()}`
  let processed = 0
  let reachedIdle = false

  while (Date.now() - start < TIME_BUDGET_MS) {
    try {
      const job = await processOneJob(workerId)
      if (job === null) {
        reachedIdle = true
        break
      }
      processed++
    } catch (err) {
      console.error({ event: 'cron.drain.error', err: String(err), workerId })
      break
    }
  }

  const elapsedMs = Date.now() - start
  console.log({ event: 'cron.drain.done', processed, reachedIdle, elapsedMs })
  return NextResponse.json({ processed, reachedIdle, elapsedMs })
}
