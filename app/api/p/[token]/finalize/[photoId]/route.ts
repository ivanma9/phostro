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
  return NextResponse.json({ photo: result.photo })
}
