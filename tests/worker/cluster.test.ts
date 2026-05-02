import { eq } from 'drizzle-orm'
import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, faceClusters, faceDetections, photos, users } from '@/db/schema'

// Helper: normalize a vector to unit length
function normalize(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / mag)
}

// Helper: build a 128-d vector that is mostly zeros with one value at position `pos`
function unitVec(pos: number): number[] {
  const v = new Array(128).fill(0)
  v[pos] = 1.0
  return v // already unit length
}

// Helper: build near-identical embeddings (tiny perturbations around [0.5, 0.5, ...])
function nearIdentical(seed: number): number[] {
  const base = new Array(128).fill(0.5)
  // perturb dimension `seed % 128` slightly
  base[seed % 128] += 0.001 * (seed + 1)
  return normalize(base)
}

async function seedUser(suffix: string) {
  const [u] = await db
    .insert(users)
    .values({ name: `U-${suffix}`, contact: `u_cluster_${suffix}@x.com`, contactType: 'email' })
    .returning()
  return u
}

async function seedEvent(userId: string, suffix: string) {
  const [e] = await db
    .insert(events)
    .values({
      hostUserId: userId,
      name: `E-${suffix}`,
      expiresAt: new Date(Date.now() + 86400_000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: e.id, userId, role: 'host' })
  return e
}

async function seedPhoto(eventId: string, userId: string) {
  const [p] = await db
    .insert(photos)
    .values({
      eventId,
      uploaderUserId: userId,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1000,
    })
    .returning()
  return p
}

async function seedDetection(photoId: string, embedding: number[], clusterId?: string) {
  const [d] = await db
    .insert(faceDetections)
    .values({
      photoId,
      bboxX1: 0.1,
      bboxY1: 0.1,
      bboxX2: 0.5,
      bboxY2: 0.5,
      confidence: 0.9,
      landmarksJson: [],
      embedding,
      ...(clusterId ? { clusterId } : {}),
    })
    .returning()
  return d
}

async function seedCluster(
  eventId: string,
  embedding: number[],
  memberCount = 1,
  representativeDetectionId?: string,
) {
  const [c] = await db
    .insert(faceClusters)
    .values({
      eventId,
      representativeEmbedding: embedding,
      memberCount,
      ...(representativeDetectionId ? { representativeDetectionId } : {}),
    })
    .returning()
  return c
}

beforeEach(async () => {
  await db.delete(faceDetections)
  await db.delete(faceClusters)
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

// C1: 3 similar detections → 1 cluster, member_count=3
test('C1: three near-identical detections produce 1 cluster with member_count=3', async () => {
  const u = await seedUser('c1')
  const e = await seedEvent(u.id, 'c1')
  const p = await seedPhoto(e.id, u.id)

  await seedDetection(p.id, nearIdentical(0))
  await seedDetection(p.id, nearIdentical(1))
  await seedDetection(p.id, nearIdentical(2))

  const { runClusterJob } = await import('@/lib/worker/cluster')
  await runClusterJob()

  const clusters = await db.select().from(faceClusters).where(eq(faceClusters.eventId, e.id))
  expect(clusters).toHaveLength(1)
  expect(clusters[0].memberCount).toBe(3)

  const detections = await db.select().from(faceDetections).where(eq(faceDetections.photoId, p.id))
  expect(detections.every((d) => d.clusterId === clusters[0].id)).toBe(true)
})

// C2: 3 orthogonal detections → 3 clusters, each member_count=1
test('C2: three orthogonal detections produce 3 clusters each with member_count=1', async () => {
  const u = await seedUser('c2')
  const e = await seedEvent(u.id, 'c2')
  const p = await seedPhoto(e.id, u.id)

  // Orthogonal unit vectors: cosine distance = 1.0 (way above threshold 0.582)
  await seedDetection(p.id, unitVec(0))
  await seedDetection(p.id, unitVec(1))
  await seedDetection(p.id, unitVec(2))

  const { runClusterJob } = await import('@/lib/worker/cluster')
  await runClusterJob()

  const clusters = await db.select().from(faceClusters).where(eq(faceClusters.eventId, e.id))
  expect(clusters).toHaveLength(3)
  expect(clusters.every((c) => c.memberCount === 1)).toBe(true)
})

// C3: cross-event isolation — same embeddings in 2 events → 2 clusters (never shared)
test('C3: same embeddings in two different events produce separate clusters (event scope)', async () => {
  const u = await seedUser('c3')
  const e1 = await seedEvent(u.id, 'c3a')
  const e2 = await seedEvent(u.id, 'c3b')
  const p1 = await seedPhoto(e1.id, u.id)
  const p2 = await seedPhoto(e2.id, u.id)

  const emb = nearIdentical(0)
  await seedDetection(p1.id, emb)
  await seedDetection(p1.id, nearIdentical(1))
  await seedDetection(p2.id, emb)
  await seedDetection(p2.id, nearIdentical(2))

  const { runClusterJob } = await import('@/lib/worker/cluster')
  await runClusterJob()

  const allClusters = await db.select().from(faceClusters)
  // Must be exactly 2 clusters — one per event
  expect(allClusters).toHaveLength(2)

  const e1Clusters = allClusters.filter((c) => c.eventId === e1.id)
  const e2Clusters = allClusters.filter((c) => c.eventId === e2.id)
  expect(e1Clusters).toHaveLength(1)
  expect(e2Clusters).toHaveLength(1)
  // And never the same cluster id
  expect(e1Clusters[0].id).not.toBe(e2Clusters[0].id)
})

// C4: already-clustered detections are skipped (idempotent)
test('C4: already-clustered detections are not re-processed', async () => {
  const u = await seedUser('c4')
  const e = await seedEvent(u.id, 'c4')
  const p = await seedPhoto(e.id, u.id)

  const emb = nearIdentical(0)
  const existingCluster = await seedCluster(e.id, emb, 1)
  await seedDetection(p.id, emb, existingCluster.id)

  const { runClusterJob } = await import('@/lib/worker/cluster')
  await runClusterJob()

  const clusters = await db.select().from(faceClusters)
  // No new cluster created
  expect(clusters).toHaveLength(1)
  expect(clusters[0].id).toBe(existingCluster.id)
  // member_count unchanged
  expect(clusters[0].memberCount).toBe(1)
})

// C5: running mean updates representative_embedding correctly
test('C5: running mean produces correct representative_embedding for 2 similar detections', async () => {
  const u = await seedUser('c5')
  const e = await seedEvent(u.id, 'c5')
  const p = await seedPhoto(e.id, u.id)

  const emb1 = normalize([1, 0, ...new Array(126).fill(0)])
  const emb2 = normalize([0.95, 0.05, ...new Array(126).fill(0)])

  await seedDetection(p.id, emb1)
  await seedDetection(p.id, emb2)

  const { runClusterJob } = await import('@/lib/worker/cluster')
  await runClusterJob()

  const clusters = await db.select().from(faceClusters).where(eq(faceClusters.eventId, e.id))
  expect(clusters).toHaveLength(1)
  expect(clusters[0].memberCount).toBe(2)

  // The representative should be the mean of emb1 and emb2 (raw mean, not re-normalized)
  // mean[0] ≈ (1 + 0.95) / 2 = 0.975; mean[1] ≈ (0 + 0.05) / 2 = 0.025
  const rep = clusters[0].representativeEmbedding as number[]
  expect(rep[0]).toBeCloseTo((emb1[0] + emb2[0]) / 2, 3)
  expect(rep[1]).toBeCloseTo((emb1[1] + emb2[1]) / 2, 3)
  // All other dims should remain 0
  for (let i = 2; i < 128; i++) {
    expect(rep[i]).toBeCloseTo(0, 5)
  }
})

// C6: worker.cluster.run_completed log emitted with correct counts
test('C6: runClusterJob emits worker.cluster.run_completed with correct counts', async () => {
  const u = await seedUser('c6')
  const e = await seedEvent(u.id, 'c6')
  const p = await seedPhoto(e.id, u.id)

  await seedDetection(p.id, nearIdentical(0))
  await seedDetection(p.id, nearIdentical(1))
  await seedDetection(p.id, nearIdentical(2))

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

  const { runClusterJob } = await import('@/lib/worker/cluster')
  const result = await runClusterJob()

  const completedCall = logSpy.mock.calls.find(
    (args) =>
      args[0] &&
      typeof args[0] === 'object' &&
      (args[0] as { event?: string }).event === 'worker.cluster.run_completed',
  )

  expect(completedCall).toBeDefined()
  if (!completedCall) throw new Error('unreachable')
  const payload = completedCall[0] as {
    event: string
    eventsProcessed: number
    detectionsClustered: number
    clustersCreated: number
    elapsedMs: number
  }
  expect(payload.eventsProcessed).toBe(1)
  expect(payload.detectionsClustered).toBe(3)
  expect(payload.clustersCreated).toBe(1)
  expect(typeof payload.elapsedMs).toBe('number')

  // Also check return value
  expect(result.eventsProcessed).toBe(1)
  expect(result.detectionsClustered).toBe(3)
  expect(result.clustersCreated).toBe(1)
  expect(typeof result.elapsedMs).toBe('number')

  logSpy.mockRestore()
})

// C7: existing cluster + new similar detection → member_count=2, assigned
test('C7: new similar detection merges into existing cluster (member_count=2)', async () => {
  const u = await seedUser('c7')
  const e = await seedEvent(u.id, 'c7')
  const p = await seedPhoto(e.id, u.id)

  const emb = nearIdentical(0)
  const existingCluster = await seedCluster(e.id, emb, 1)
  // The first detection is already clustered
  await seedDetection(p.id, emb, existingCluster.id)
  // The second detection is unclustered but similar
  await seedDetection(p.id, nearIdentical(1))

  const { runClusterJob } = await import('@/lib/worker/cluster')
  await runClusterJob()

  const clusters = await db.select().from(faceClusters).where(eq(faceClusters.eventId, e.id))
  expect(clusters).toHaveLength(1)
  expect(clusters[0].memberCount).toBe(2)

  const detections = await db.select().from(faceDetections).where(eq(faceDetections.photoId, p.id))
  expect(detections.every((d) => d.clusterId === existingCluster.id)).toBe(true)
})

// C8: existing cluster + new dissimilar detection → 2 clusters
test('C8: new dissimilar detection creates a second cluster', async () => {
  const u = await seedUser('c8')
  const e = await seedEvent(u.id, 'c8')
  const p = await seedPhoto(e.id, u.id)

  const emb1 = unitVec(0)
  const existingCluster = await seedCluster(e.id, emb1, 1)
  await seedDetection(p.id, emb1, existingCluster.id)
  // Orthogonal = far away
  await seedDetection(p.id, unitVec(1))

  const { runClusterJob } = await import('@/lib/worker/cluster')
  await runClusterJob()

  const clusters = await db.select().from(faceClusters).where(eq(faceClusters.eventId, e.id))
  expect(clusters).toHaveLength(2)
  const existing = clusters.find((c) => c.id === existingCluster.id)
  const newCluster = clusters.find((c) => c.id !== existingCluster.id)
  expect(existing).toBeDefined()
  expect(newCluster).toBeDefined()
  expect(existing?.memberCount).toBe(1)
  expect(newCluster?.memberCount).toBe(1)
})
