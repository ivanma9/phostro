import { sql } from 'drizzle-orm'
import { db } from '@/db'

/**
 * Match distance threshold for cosine similarity.
 *
 * Read from MATCH_MAX_DISTANCE env var at call time (not module load), so tests
 * can override it without module reload. Defaults to 0.582 (same as
 * worker/config/thresholds.json placeholder). The lib/ side intentionally does
 * NOT import the JSON to avoid a cross-package dependency on worker/.
 */
function getMatchMaxDistance(override?: number): number {
  if (override != null) return override
  const raw = process.env.MATCH_MAX_DISTANCE
  if (raw != null && raw !== '') {
    const n = parseFloat(raw)
    if (Number.isFinite(n)) return n
  }
  return 0.582
}

export interface ClusterJobResult {
  eventsProcessed: number
  detectionsClustered: number
  clustersCreated: number
  elapsedMs: number
}

export interface ClusterJobOpts {
  matchMaxDistance?: number
}

type EventRow = { event_id: string }
type DetectionRow = { id: string; embedding: string | number[] }
type ClusterRow = {
  id: string
  representative_embedding: string | number[]
  member_count: number
  distance: number
}
type InsertedRow = { id: string }

/**
 * Runs the per-event incremental cosine clustering job.
 *
 * For every event that has unclustered face_detections (cluster_id IS NULL):
 *   1. Iterate unclustered detections in created_at ASC order (deterministic).
 *   2. For each detection, query existing clusters ordered by cosine distance.
 *   3. If nearest cluster distance < matchMaxDistance: assign + update running mean.
 *   4. Else: create a new cluster seeded with this detection's embedding.
 *
 * Each event's work is wrapped in a transaction so a failure mid-event rolls
 * back partial assignments, making the job safe to resume.
 */
export async function runClusterJob(opts?: ClusterJobOpts): Promise<ClusterJobResult> {
  const started = Date.now()
  const threshold = getMatchMaxDistance(opts?.matchMaxDistance)

  let eventsProcessed = 0
  let detectionsClustered = 0
  let clustersCreated = 0

  try {
    // postgres-js driver returns an array-like result (not {rows:[...]})
    const eventsWithUnclustered = Array.from(
      (await db.execute(sql`
        SELECT DISTINCT p.event_id
        FROM face_detections fd
        JOIN photos p ON p.id = fd.photo_id
        WHERE fd.cluster_id IS NULL
      `)) as unknown as EventRow[],
    )

    for (const row of eventsWithUnclustered) {
      const eventId = row.event_id

      const { clustered, created } = await db.transaction(async (tx) => {
        let txClustered = 0
        let txCreated = 0

        // Fetch unclustered detections for this event, ordered by created_at ASC
        const unclusteredDetections = Array.from(
          (await tx.execute(sql`
            SELECT fd.id, fd.embedding
            FROM face_detections fd
            JOIN photos p ON p.id = fd.photo_id
            WHERE p.event_id = ${eventId}
              AND fd.cluster_id IS NULL
            ORDER BY fd.created_at ASC, fd.id ASC
          `)) as unknown as DetectionRow[],
        )

        for (const det of unclusteredDetections) {
          // postgres-js returns pgvector columns as a string "[x,x,...]" in raw SQL
          const rawEmb = det.embedding
          const embedding: number[] = typeof rawEmb === 'string' ? JSON.parse(rawEmb) : rawEmb
          // pgvector expects '[x,x,x,...]' string format
          const embeddingLiteral = `[${embedding.join(',')}]`

          // Find nearest cluster for this event using pgvector <=> cosine distance
          const nearestCluster = Array.from(
            (await tx.execute(sql`
              SELECT
                fc.id,
                fc.representative_embedding,
                fc.member_count,
                (fc.representative_embedding <=> ${embeddingLiteral}::vector) AS distance
              FROM face_clusters fc
              WHERE fc.event_id = ${eventId}
              ORDER BY fc.representative_embedding <=> ${embeddingLiteral}::vector
              LIMIT 1
            `)) as unknown as ClusterRow[],
          )

          if (nearestCluster.length > 0 && nearestCluster[0].distance < threshold) {
            // Assign to existing cluster + update running mean
            const cluster = nearestCluster[0]
            const oldCount = cluster.member_count
            // representative_embedding also comes back as string from raw SQL
            const rawMean = cluster.representative_embedding
            const oldMean: number[] = typeof rawMean === 'string' ? JSON.parse(rawMean) : rawMean
            const newCount = oldCount + 1

            // Running mean: new_mean = (old_mean * old_count + new_embedding) / new_count
            const newMean = oldMean.map((v, i) => (v * oldCount + embedding[i]) / newCount)
            const newMeanLiteral = `[${newMean.join(',')}]`

            await tx.execute(sql`
              UPDATE face_clusters
              SET
                member_count = ${newCount},
                representative_embedding = ${newMeanLiteral}::vector,
                updated_at = now()
              WHERE id = ${cluster.id}
            `)

            await tx.execute(sql`
              UPDATE face_detections
              SET cluster_id = ${cluster.id}
              WHERE id = ${det.id}
            `)

            txClustered++
          } else {
            // Create a new cluster seeded with this detection's embedding
            const inserted = Array.from(
              (await tx.execute(sql`
                INSERT INTO face_clusters (event_id, representative_embedding, representative_detection_id, member_count)
                VALUES (${eventId}, ${embeddingLiteral}::vector, ${det.id}, 1)
                RETURNING id
              `)) as unknown as InsertedRow[],
            )

            const newClusterId = inserted[0].id

            await tx.execute(sql`
              UPDATE face_detections
              SET cluster_id = ${newClusterId}
              WHERE id = ${det.id}
            `)

            txClustered++
            txCreated++
          }
        }

        return { clustered: txClustered, created: txCreated }
      })

      eventsProcessed++
      detectionsClustered += clustered
      clustersCreated += created
    }

    const elapsedMs = Date.now() - started

    console.log({
      event: 'worker.cluster.run_completed',
      eventsProcessed,
      detectionsClustered,
      clustersCreated,
      elapsedMs,
    })

    return { eventsProcessed, detectionsClustered, clustersCreated, elapsedMs }
  } catch (err: unknown) {
    const elapsedMs = Date.now() - started
    const stack = err instanceof Error ? err.stack : String(err)
    const message = err instanceof Error ? err.message : String(err)

    console.error({
      event: 'worker.cluster.failed',
      error: message,
      stack,
      eventsProcessed,
      detectionsClustered,
      clustersCreated,
      elapsedMs,
    })

    throw err
  }
}
