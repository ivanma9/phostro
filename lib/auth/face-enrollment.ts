import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userFaceEmbeddings } from '@/db/schema'

export const FACE_SCAN_ANGLES = ['frontal', 'left', 'right'] as const
export type FaceScanAngle = (typeof FACE_SCAN_ANGLES)[number]

export type EnrollmentStatus = {
  /** True only when all FACE_SCAN_ANGLES have been captured. */
  enrolled: boolean
  enrolledAngles: FaceScanAngle[]
  remainingAngles: FaceScanAngle[]
}

export function isFaceScanAngle(value: unknown): value is FaceScanAngle {
  return typeof value === 'string' && (FACE_SCAN_ANGLES as readonly string[]).includes(value)
}

export async function getFaceEnrollment(userId: string): Promise<EnrollmentStatus> {
  const rows = await db
    .select({ angle: userFaceEmbeddings.angle })
    .from(userFaceEmbeddings)
    .where(eq(userFaceEmbeddings.userId, userId))

  const present = new Set(rows.map((r) => r.angle as FaceScanAngle))
  const enrolledAngles = FACE_SCAN_ANGLES.filter((a) => present.has(a))
  const remainingAngles = FACE_SCAN_ANGLES.filter((a) => !present.has(a))
  return {
    enrolled: remainingAngles.length === 0,
    enrolledAngles,
    remainingAngles,
  }
}

/**
 * Loads all enrollment embeddings for a user, ordered by FACE_SCAN_ANGLES so
 * callers get a deterministic vector list. Returns an empty array if the user
 * is not enrolled. Used by the matcher (listYouFeed) and quality-gate checks.
 */
export async function getFaceEmbeddings(userId: string): Promise<
  Array<{ angle: FaceScanAngle; embedding: number[] }>
> {
  const rows = await db
    .select({ angle: userFaceEmbeddings.angle, embedding: userFaceEmbeddings.embedding })
    .from(userFaceEmbeddings)
    .where(eq(userFaceEmbeddings.userId, userId))
  // Drizzle's vector custom type returns number[] already.
  const map = new Map(rows.map((r) => [r.angle as FaceScanAngle, r.embedding]))
  return FACE_SCAN_ANGLES.filter((a) => map.has(a)).map((a) => ({
    angle: a,
    embedding: map.get(a)!,
  }))
}

/**
 * Per-design yaw thresholds. Tune empirically once the founder's first scan
 * produces real yaw scores.
 */
export const YAW_FRONTAL_MAX = 0.10
export const YAW_TURN_MIN = 0.18

export type PoseValidation =
  | { ok: true }
  | { ok: false; reason: 'wrong_pose'; expected: FaceScanAngle; yaw: number }

// Sign convention is fixed by worker/recognition/detect.py::estimate_yaw and
// pinned by worker/tests/test_yaw_estimation.py:
//   - User turns head to their LEFT  → nose shifts to image-right → yaw > 0
//   - User turns head to their RIGHT → nose shifts to image-left  → yaw < 0
// Magnitudes (YAW_FRONTAL_MAX, YAW_TURN_MIN) are tuned empirically; the SIGN is
// load-bearing and must not be flipped without updating the test + docstrings.
export function validatePoseForAngle(angle: FaceScanAngle, yaw: number): PoseValidation {
  if (angle === 'frontal') {
    if (Math.abs(yaw) < YAW_FRONTAL_MAX) return { ok: true }
    return { ok: false, reason: 'wrong_pose', expected: angle, yaw }
  }
  if (angle === 'left') {
    if (yaw >= YAW_TURN_MIN) return { ok: true }
    return { ok: false, reason: 'wrong_pose', expected: angle, yaw }
  }
  // angle === 'right'
  if (yaw <= -YAW_TURN_MIN) return { ok: true }
  return { ok: false, reason: 'wrong_pose', expected: angle, yaw }
}

/**
 * Cosine distance between two L2-normalized embeddings. Mirrors pgvector's
 * `<=>` operator, computed in JS for the enrollment-time similarity gate.
 */
export function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineDistance: length mismatch ${a.length} vs ${b.length}`)
  }
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return 1 - dot
}

/**
 * Belt-and-suspenders gate alongside the yaw check: if a freshly captured
 * embedding is suspiciously close to ALL previously enrolled angles, the user
 * probably did not actually turn their head despite passing the pose check.
 *
 * Returns null if all distances are above the floor; otherwise returns the
 * recorded distances for diagnostics.
 */
export const TOO_SIMILAR_DISTANCE_FLOOR = 0.20

export function detectTooSimilar(
  newEmbedding: number[],
  existing: Array<{ angle: FaceScanAngle; embedding: number[] }>,
): { distances: Array<{ angle: FaceScanAngle; distance: number }> } | null {
  if (existing.length === 0) return null
  const distances = existing.map((e) => ({
    angle: e.angle,
    distance: cosineDistance(newEmbedding, e.embedding),
  }))
  const allTooSimilar = distances.every((d) => d.distance < TOO_SIMILAR_DISTANCE_FLOOR)
  return allTooSimilar ? { distances } : null
}
