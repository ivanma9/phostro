import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { processOneJob } from '@/lib/worker/dispatcher'

export const runtime = 'nodejs'

/**
 * Debug-only endpoint: claims and processes one job from the photo-jobs queue.
 *
 * Gated by NODE_ENV !== 'production', identical to the test-login pattern.
 * Used by Playwright e2e specs to drive the dispatcher synchronously without
 * requiring an external worker daemon. POST /api/internal/process-one-job once
 * per uploaded photo to drain the queue before polling the You feed.
 *
 * CI note: the Python face-detection worker (uvicorn) must be running at
 * WORKER_URL (default http://localhost:8000) for this endpoint to succeed.
 */
export async function POST(): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const workerId = `e2e-internal-${randomUUID()}`
  const job = await processOneJob(workerId)

  if (job === null) {
    return NextResponse.json({ processed: false, reason: 'no_job_available' })
  }

  return NextResponse.json({ processed: true, jobId: job.id, photoId: job.photoId })
}
