import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { finalizePhotoCore } from '@/lib/photos/finalize-core'

export const runtime = 'nodejs'
// Sharp + R2 round-trips can take 10s+ on large HEICs. Bump above the Vercel default.
export const maxDuration = 60

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  const { id: eventId, photoId } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const result = await finalizePhotoCore(eventId, photoId, { kind: 'user', userId: user.id })

  if (!result.ok) return NextResponse.json(result.body, { status: result.status })
  return NextResponse.json({ photo: result.photo })
}
