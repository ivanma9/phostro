import { NextResponse } from 'next/server'
import { finalizePhotoCore } from '@/lib/photos/finalize-core'
import { ShareLinkError, verifyShareLink } from '@/lib/share-links/storage'

export const runtime = 'nodejs'
export const maxDuration = 60

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

  // Pre-warm the Fly worker. The detect job we just queued will be picked up
  // by the cron drain in the next 0–120s; if the worker is cold (Fly trial
  // forces stop semantics, ~30s boot) the first cron tick aborts mid-call. By
  // pinging /health here we trigger Fly's proxy to start the machine *now*, so
  // it's warm by the time cron fires. We await briefly to guarantee the SYN
  // leaves Vercel's box before the function suspends — Fly starts the machine
  // on connection attempt regardless of whether our fetch later times out.
  const workerUrl = process.env.WORKER_URL
  if (workerUrl) {
    await fetch(`${workerUrl}/health`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => {
      // Cold worker → connection times out within 500ms. That's expected and
      // fine: the connection attempt itself triggers Fly to start the machine.
    })
  }

  return NextResponse.json({ photo: result.photo })
}
