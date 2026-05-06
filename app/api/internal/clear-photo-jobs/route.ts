import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export const runtime = 'nodejs'

/**
 * Debug-only endpoint: marks all queued/claimed photo_jobs as failed so e2e specs
 * start with a clean queue. Prevents stale jobs from prior runs consuming the
 * process-one-job retries before the current test's job is reachable.
 *
 * Gated by NODE_ENV !== 'production', identical to the test-login pattern.
 */
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const result = await db.execute(sql`
    UPDATE photo_jobs
    SET state = 'failed', last_error = 'cleared by e2e teardown', updated_at = now()
    WHERE state IN ('queued', 'claimed')
  `)

  const count = (result as unknown as { count?: number }).count ?? 0
  return NextResponse.json({ cleared: count })
}
