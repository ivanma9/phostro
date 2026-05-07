import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { createPresignedPutUrl } from '@/lib/photos/r2'

// Two-step enrollment to bypass Vercel's 4.5MB request body cap:
// 1) /api/me/face/init    — presigns an R2 PUT URL; client uploads selfie directly to R2
// 2) /api/me/face/finalize — server fetches from R2, runs Sharp + worker /detect, stores embedding

export const runtime = 'nodejs'

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

// Selfie upload cap. Larger than the in-function 10 MB because direct-to-R2
// has no Vercel body limit; raised to 25 MB to comfortably fit any phone selfie.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const PUT_URL_TTL_SECONDS = 5 * 60

function enrollmentPendingKey(userId: string, nonce: string): string {
  return `enrollment-pending/${userId}/${nonce}.bin`
}

export async function POST(req: Request): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const body = (await req.json().catch(() => null)) as {
    mimeType?: unknown
    sizeBytes?: unknown
  } | null

  if (!body) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : ''
  if (!ALLOWED_MIMES.has(mimeType)) {
    return NextResponse.json({ error: 'invalid_file' }, { status: 400 })
  }

  const sizeBytes =
    typeof body.sizeBytes === 'number' && Number.isInteger(body.sizeBytes) ? body.sizeBytes : -1
  if (sizeBytes <= 0) {
    return NextResponse.json({ error: 'invalid_size' }, { status: 400 })
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 413 })
  }

  const nonce = randomUUID()
  const key = enrollmentPendingKey(user.id, nonce)
  const putUrl = await createPresignedPutUrl(key, mimeType, PUT_URL_TTL_SECONDS)

  return NextResponse.json({ key, putUrl })
}
