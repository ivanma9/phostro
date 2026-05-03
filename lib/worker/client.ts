import { createHmac } from 'node:crypto'
import { createPresignedGetUrl } from '@/lib/photos/r2'

export type FaceOut = {
  bbox_x1: number
  bbox_y1: number
  bbox_x2: number
  bbox_y2: number
  confidence: number
  /** 5x2 landmark points */
  landmarks: number[][]
  /** 128-dimensional embedding */
  embedding: number[]
}

export type DetectResponse = {
  photo_id: string
  faces: FaceOut[]
  elapsed_ms: number
}

/**
 * Calls the Python worker's /detect endpoint.
 *
 * - Mints a 5-minute presigned R2 GET URL for the preview key.
 * - Signs the request body with HMAC-SHA256 using WORKER_SECRET.
 * - 30s timeout; no internal retries (the job queue retries).
 *
 * @throws if the worker returns a non-2xx response or the request times out.
 */
export async function detectPhoto(photoId: string, previewKey: string): Promise<DetectResponse> {
  const workerUrl = process.env.WORKER_URL
  const workerSecret = process.env.WORKER_SECRET
  if (!workerUrl) throw new Error('WORKER_URL is not set')
  if (!workerSecret) throw new Error('WORKER_SECRET is not set')

  // Mint presigned GET URL (5 minutes = 300 seconds)
  const presignedUrl = await createPresignedGetUrl(previewKey, 300)

  // Stringify once — same bytes used for hashing AND sending
  const bodyStr = JSON.stringify({ photo_id: photoId, preview_get_url: presignedUrl })

  // HMAC-SHA256 over body bytes
  const signature = 'sha256=' + createHmac('sha256', workerSecret).update(bodyStr, 'utf8').digest('hex')

  // 30s timeout via AbortController
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)

  let response: Response
  try {
    response = await fetch(`${workerUrl}/detect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Signature': signature,
      },
      body: bodyStr,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    // Parse worker error shape: { "error": "worker.<area>.<event>", ... }
    let errorName = `worker_http_${response.status}`
    try {
      const errBody = (await response.json()) as { error?: string }
      if (errBody.error) errorName = errBody.error
    } catch {
      // Ignore JSON parse failure; use status-based fallback
    }
    throw new Error(errorName)
  }

  return response.json() as Promise<DetectResponse>
}
