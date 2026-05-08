import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { userFaceEmbeddings } from '@/db/schema'
import {
  detectTooSimilar,
  getFaceEmbeddings,
  getFaceEnrollment,
  isFaceScanAngle,
  validatePoseForAngle,
  type FaceScanAngle,
} from '@/lib/auth/face-enrollment'
import { getCurrentUser } from '@/lib/auth/current-user'
import { MAX_UPLOAD_BYTES } from '@/lib/photos/keys'
import { ImageProcessError, processImage } from '@/lib/photos/process'
import { deleteObject, getObjectBuffer, headObject, putObject } from '@/lib/photos/r2'
import { detectPhoto } from '@/lib/worker/client'

// Multi-angle face scan finalize (v1).
// Companion to /api/me/face/init. Body: { key, angle }.
// Server: fetch from R2 → Sharp processImage → worker /detect (returns yaw) →
// pose-vs-claimed-angle check → similarity-vs-existing-angles gate → UPSERT into
// user_face_embeddings keyed on (user_id, angle). Returns enrollment status.

export const runtime = 'nodejs'
export const maxDuration = 60

function emit(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...data }))
}

export async function POST(req: Request): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const body = (await req.json().catch(() => null)) as
    | { key?: unknown; angle?: unknown }
    | null
  if (!body) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  const key = typeof body.key === 'string' ? body.key : ''
  const angle = body.angle
  if (!isFaceScanAngle(angle)) {
    return NextResponse.json({ error: 'invalid_angle' }, { status: 400 })
  }

  const expectedPrefix = `enrollment-pending/${user.id}/`
  if (!key.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: 'invalid_key' }, { status: 400 })
  }

  const head = await headObject(key)
  if (!head) {
    return NextResponse.json({ error: 'upload_not_found' }, { status: 404 })
  }
  if (head.contentLength > MAX_UPLOAD_BYTES) {
    await deleteObject(key).catch(() => {})
    return NextResponse.json({ error: 'too_large' }, { status: 413 })
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

  // Stable per-angle preview key for audit / re-enrollment workflows.
  const enrollmentKey = `enrollment/${user.id}/${angle}-${Date.now()}.jpg`
  await putObject(enrollmentKey, previewJpeg, 'image/jpeg')
  await deleteObject(key).catch(() => {})

  const diagnosticPhotoId = randomUUID()
  let detect: Awaited<ReturnType<typeof detectPhoto>>
  try {
    detect = await detectPhoto(diagnosticPhotoId, enrollmentKey)
  } catch (e) {
    emit('face.enroll.worker_call_failed', {
      userId: user.id,
      angle,
      error: e instanceof Error ? e.message : String(e),
    })
    return NextResponse.json({ error: 'worker_unavailable' }, { status: 503 })
  }

  const detected = detect.faces.length
  const topConfidence =
    detected > 0 ? Math.round(detect.faces[0].confidence * 100) : null

  if (detect.faces.length > 1) {
    emit('face.enroll.angle.reject_multiple', { userId: user.id, angle, detected })
    return NextResponse.json(
      { error: 'multiple_faces', angle, detected, topConfidence },
      { status: 400 },
    )
  }
  // Confidence threshold lowered from 0.9 → 0.6 for v0 dogfood. RetinaFace
  // returns 0.7-0.85 for many real selfies; revisit on Phase-4 retune.
  if (detect.faces.length === 0 || detect.faces[0].confidence <= 0.6) {
    emit('face.enroll.angle.reject_no_face', { userId: user.id, angle, detected })
    return NextResponse.json(
      { error: 'no_face', angle, detected, topConfidence },
      { status: 400 },
    )
  }

  const face = detect.faces[0]
  const qualityScore = Math.round(face.confidence * 100)

  // Pose-vs-claimed-angle gate from RetinaFace landmarks. Without this, a user
  // could tap "left" three times while looking forward and get three near-identical
  // embeddings — defeating the purpose of multi-angle enrollment.
  const pose = validatePoseForAngle(angle, face.yaw)
  if (!pose.ok) {
    emit('face.enroll.angle.reject_wrong_pose', {
      userId: user.id,
      angle,
      yaw: face.yaw,
      expected: pose.expected,
    })
    return NextResponse.json(
      { error: 'wrong_pose', angle, yaw: face.yaw, expected: pose.expected, topConfidence },
      { status: 400 },
    )
  }

  // Belt-and-suspenders: reject if the new embedding is suspiciously close to
  // every other angle the user has already enrolled.
  const existing = (await getFaceEmbeddings(user.id)).filter((e) => e.angle !== angle)
  const tooSimilar = detectTooSimilar(face.embedding, existing)
  if (tooSimilar) {
    emit('face.enroll.angle.reject_too_similar', {
      userId: user.id,
      angle,
      yaw: face.yaw,
      distances: tooSimilar.distances,
    })
    return NextResponse.json(
      {
        error: 'too_similar_to_existing',
        angle,
        yaw: face.yaw,
        distances: tooSimilar.distances,
      },
      { status: 400 },
    )
  }

  // UPSERT keyed on (user_id, angle).
  await db
    .insert(userFaceEmbeddings)
    .values({
      userId: user.id,
      angle,
      embedding: face.embedding,
      qualityScore,
      yaw: face.yaw,
      previewR2Key: enrollmentKey,
    })
    .onConflictDoUpdate({
      target: [userFaceEmbeddings.userId, userFaceEmbeddings.angle],
      set: {
        embedding: face.embedding,
        qualityScore,
        yaw: face.yaw,
        previewR2Key: enrollmentKey,
        enrolledAt: sql`now()`,
      },
    })

  const status = await getFaceEnrollment(user.id)
  emit('face.enroll.angle.success', {
    userId: user.id,
    angle,
    qualityScore,
    yaw: face.yaw,
    enrolledAngles: status.enrolledAngles,
  })

  return NextResponse.json({
    angle,
    quality: qualityScore,
    yaw: face.yaw,
    enrolled: status.enrolled,
    enrolledAngles: status.enrolledAngles,
    remainingAngles: status.remainingAngles,
  })
}
