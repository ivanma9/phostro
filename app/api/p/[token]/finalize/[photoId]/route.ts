import { randomUUID } from 'node:crypto'
import { after, NextResponse } from 'next/server'
import { processOneJob } from '@/lib/worker/dispatcher'
import { finalizePhotoCore } from '@/lib/photos/finalize-core'
import { ShareLinkError, verifyShareLink } from '@/lib/share-links/storage'

export const runtime = 'nodejs'
export const maxDuration = 60

// Number of queued jobs to attempt to drain per finalize call. Each contributor
// upload tries to process its own job + any older stragglers. Caps the in-flight
// drain so a backed-up queue doesn't time out a single finalize handler.
const DRAIN_BATCH = 5

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ token: string; photoId: string }> },
) {
  const { token, photoId } = await params

  let link: Awaited<ReturnType<typeof verifyShareLink>>
  try {
    // Non-atomic init-time read. The source of truth at finalize time is
    // incrementShareLinkUsage inside finalizePhotoCore's transaction.
    link = await verifyShareLink(token)
  } catch (e) {
    if (e instanceof ShareLinkError) {
      const status = e.code === 'invalid' ? 404 : e.code === 'exhausted' ? 429 : 410
      return NextResponse.json({ error: e.code }, { status })
    }
    throw e
  }

  const result = await finalizePhotoCore(link.eventId, photoId, {
    kind: 'token',
    token,
    linkId: link.linkId,
  })

  if (!result.ok) return NextResponse.json(result.body, { status: result.status })

  // Drain the queue in the background. Without a long-running dispatcher in
  // production, queued photo_jobs would never get picked up — face_detections
  // never written and the You feed stays empty. after() runs after the response
  // is sent so the contributor doesn't wait on detection. Each worker call
  // takes ~1-3s; DRAIN_BATCH bounds it to ~15s worst case.
  after(async () => {
    const workerId = `inline-drain-${randomUUID()}`
    for (let i = 0; i < DRAIN_BATCH; i++) {
      try {
        const job = await processOneJob(workerId)
        if (job === null) break
      } catch (err) {
        console.error('inline drain failed', { err: String(err) })
        break
      }
    }
  })

  return NextResponse.json({ photo: result.photo })
}
