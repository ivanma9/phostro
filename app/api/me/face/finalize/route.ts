import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { users } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { ImageProcessError, processImage } from '@/lib/photos/process'
import { deleteObject, getObjectBuffer, putObject } from '@/lib/photos/r2'
import { detectPhoto } from '@/lib/worker/client'

// Companion to /api/me/face/init. Client posts the R2 key it uploaded to;
// server fetches the bytes from R2, runs Sharp + worker /detect, and writes
// users.face_embedding. Mirrors the legacy /api/me/face logic but takes a key
// instead of a multipart body.

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: Request): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const body = (await req.json().catch(() => null)) as { key?: unknown } | null
  if (!body) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  const key = typeof body.key === 'string' ? body.key : ''
  // Authorize: caller can only finalize keys under their own enrollment-pending prefix
  const expectedPrefix = `enrollment-pending/${user.id}/`
  if (!key.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: 'invalid_key' }, { status: 400 })
  }

  let rawBuf: Buffer
  try {
    rawBuf = await getObjectBuffer(key)
  } catch {
    return NextResponse.json({ error: 'upload_not_found' }, { status: 404 })
  }

  let previewJpeg: Buffer
  try {
    const processed = await processImage(rawBuf)
    previewJpeg = processed.previewJpeg
  } catch (e) {
    if (e instanceof ImageProcessError) {
      return NextResponse.json({ error: 'invalid_file' }, { status: 400 })
    }
    throw e
  }

  // Upload the processed preview to a stable enrollment/ key — this is what
  // the worker will read via presigned GET.
  const enrollmentKey = `enrollment/${user.id}/${Date.now()}.jpg`
  await putObject(enrollmentKey, previewJpeg, 'image/jpeg')

  // Best-effort delete of the raw upload — keep enrollment-pending/ tidy.
  await deleteObject(key).catch(() => {
    // Lifecycle rule will clean this up if delete races; not worth surfacing.
  })

  const diagnosticPhotoId = randomUUID()
  let detect: Awaited<ReturnType<typeof detectPhoto>>
  try {
    detect = await detectPhoto(diagnosticPhotoId, enrollmentKey)
  } catch {
    return NextResponse.json({ error: 'worker_unavailable' }, { status: 503 })
  }

  if (detect.faces.length > 1) {
    return NextResponse.json({ error: 'multiple_faces' }, { status: 400 })
  }
  if (detect.faces.length === 0 || detect.faces[0].confidence <= 0.9) {
    return NextResponse.json({ error: 'no_face' }, { status: 400 })
  }

  const face = detect.faces[0]
  const qualityScore = Math.round(face.confidence * 100)

  await db
    .update(users)
    .set({
      faceEmbedding: face.embedding,
      faceQualityScore: qualityScore,
      faceEnrolledAt: new Date(),
    })
    .where(eq(users.id, user.id))

  return NextResponse.json({ quality: qualityScore })
}
