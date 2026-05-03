import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { users } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { ImageProcessError, processImage } from '@/lib/photos/process'
import { putObject } from '@/lib/photos/r2'
import { detectPhoto } from '@/lib/worker/client'

export const runtime = 'nodejs'
export const maxDuration = 60

// All input-shape failures (no file, wrong mime, too-large body, Sharp decode failure) collapse
// to 400 invalid_file (or too_large for size). The UI just says "try a different photo" —
// it does not need to distinguish these cases.

// 10 MB — enrollment selfies are small; no need for the 25 MB photo limit
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

// Multi-face vs one-high-one-low decision:
// We reject ANY frame where faces.length > 1, regardless of confidence levels.
// Even a low-confidence face (e.g. 0.5) is evidence of another person in the
// frame. The plan explicitly says "do not pick highest-confidence from a group
// selfie." The failure cost of silently enrolling against a background person
// in a group selfie is catastrophic (poisons the You feed forever). We therefore
// check faces.length === 1 FIRST, before checking confidence. This is the
// strictest possible interpretation of "exactly one face with confidence > 0.9."
export async function POST(req: Request): Promise<Response> {
  // 1. Auth
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  // 2. Parse multipart form-data
  let file: File | null = null
  try {
    const form = await req.formData()
    const raw = form.get('file')
    if (raw instanceof File) file = raw
  } catch {
    return NextResponse.json({ error: 'invalid_file' }, { status: 400 })
  }

  if (!file) {
    return NextResponse.json({ error: 'invalid_file' }, { status: 400 })
  }

  // 3. Validate mime type
  if (!ALLOWED_MIMES.has(file.type)) {
    return NextResponse.json({ error: 'invalid_file' }, { status: 400 })
  }

  // 4. Validate size
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 400 })
  }

  // 5. Read into buffer and process with Sharp
  const rawBuf = Buffer.from(await file.arrayBuffer())

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

  // 6. Upload preview to R2 at enrollment/{userId}/{timestamp}.jpg
  const enrollmentKey = `enrollment/${user.id}/${Date.now()}.jpg`
  await putObject(enrollmentKey, previewJpeg, 'image/jpeg')

  // 7. Call detectPhoto — pass a fresh UUID as the diagnostic photo_id
  const diagnosticPhotoId = randomUUID()
  let detect: Awaited<ReturnType<typeof detectPhoto>>
  try {
    detect = await detectPhoto(diagnosticPhotoId, enrollmentKey)
  } catch {
    return NextResponse.json({ error: 'worker_unavailable' }, { status: 503 })
  }

  // 8. Validate face count BEFORE checking confidence.
  // Reject any frame with more than one detected face, regardless of confidence —
  // even a low-confidence secondary face indicates background people in the frame.
  if (detect.faces.length > 1) {
    return NextResponse.json({ error: 'multiple_faces' }, { status: 400 })
  }

  // Exactly zero faces, or one face that doesn't meet the confidence threshold
  if (detect.faces.length === 0 || detect.faces[0].confidence <= 0.9) {
    return NextResponse.json({ error: 'no_face' }, { status: 400 })
  }

  // Exactly one face with confidence > 0.9
  const face = detect.faces[0]
  const qualityScore = Math.round(face.confidence * 100)

  // 9. Write embedding to users table (re-enrollment overwrites)
  await db
    .update(users)
    .set({
      faceEmbedding: face.embedding,
      faceQualityScore: qualityScore,
      faceEnrolledAt: new Date(),
    })
    .where(eq(users.id, user.id))

  // 10. Keep the R2 enrollment object for v1 audit/re-enrollment workflows.
  // Do NOT delete in v0 — it's useful as an audit trail and for potential
  // re-enrollment without re-upload.

  return NextResponse.json({ quality: qualityScore })
}
