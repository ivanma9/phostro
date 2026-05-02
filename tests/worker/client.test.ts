import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createHmac } from 'node:crypto'

// Mock r2 module at the top level so vi.mock hoisting takes effect
vi.mock('@/lib/photos/r2', () => ({
  createPresignedGetUrl: vi.fn(),
}))

// Helper: compute expected HMAC-SHA256 signature
function computeHmac(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

beforeEach(async () => {
  process.env.WORKER_URL = 'http://localhost:8000'
  process.env.WORKER_SECRET = 'test-secret-key'
  process.env.R2_ACCOUNT_ID = 'test-account'
  process.env.R2_ACCESS_KEY_ID = 'test-key'
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret'
  process.env.R2_BUCKET = 'test-bucket'

  // Reset mock implementations before each test
  const { createPresignedGetUrl } = await import('@/lib/photos/r2')
  vi.mocked(createPresignedGetUrl).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// C1: HMAC header is correct, presigned URL is used
test('C1: detectPhoto sends correct HMAC signature and presigned URL in body', async () => {
  const previewKey = 'events/E/preview/P.jpg'
  const photoId = 'photo-uuid-123'
  const fakePresignedUrl = 'https://r2.example.com/presigned?key=P.jpg&sig=abc'

  const { createPresignedGetUrl } = await import('@/lib/photos/r2')
  vi.mocked(createPresignedGetUrl).mockResolvedValueOnce(fakePresignedUrl)

  let capturedUrl: string | undefined
  let capturedBody: string | undefined
  let capturedHeaders: Record<string, string> = {}

  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedBody = init?.body as string
      const headers = init?.headers as Record<string, string>
      capturedHeaders = headers ?? {}
      return {
        ok: true,
        status: 200,
        json: async () => ({
          photo_id: photoId,
          faces: [],
          elapsed_ms: 42,
        }),
      }
    }),
  )

  const { detectPhoto } = await import('@/lib/worker/client')
  await detectPhoto(photoId, previewKey)

  expect(capturedUrl).toBe('http://localhost:8000/detect')

  // Body must be valid JSON with photo_id and preview_get_url
  const parsedBody = JSON.parse(capturedBody!)
  expect(parsedBody.photo_id).toBe(photoId)
  expect(parsedBody.preview_get_url).toBe(fakePresignedUrl)

  // HMAC must match: computed over exact body bytes with WORKER_SECRET
  const expectedSig = computeHmac(capturedBody!, 'test-secret-key')
  expect(capturedHeaders['X-Worker-Signature']).toBe(expectedSig)
})

// C2: Returns parsed response on 200
test('C2: detectPhoto returns faces array on 200 response', async () => {
  const photoId = 'photo-uuid-456'
  const cannedFaces = [
    {
      bbox_x1: 0.1,
      bbox_y1: 0.2,
      bbox_x2: 0.5,
      bbox_y2: 0.7,
      confidence: 0.99,
      landmarks: [
        [0.2, 0.3],
        [0.4, 0.3],
        [0.3, 0.5],
        [0.2, 0.6],
        [0.4, 0.6],
      ],
      embedding: Array.from({ length: 128 }, (_, i) => i / 128),
    },
  ]

  const { createPresignedGetUrl } = await import('@/lib/photos/r2')
  vi.mocked(createPresignedGetUrl).mockResolvedValueOnce('https://r2.example.com/presigned')

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        photo_id: photoId,
        faces: cannedFaces,
        elapsed_ms: 100,
      }),
    }),
  )

  const { detectPhoto } = await import('@/lib/worker/client')
  const result = await detectPhoto(photoId, 'events/E/preview/P.jpg')

  expect(result.faces).toHaveLength(1)
  expect(result.faces[0].confidence).toBe(0.99)
  expect(result.faces[0].embedding).toHaveLength(128)
  expect(result.faces[0].bbox_x1).toBe(0.1)
  expect(result.elapsed_ms).toBe(100)
  expect(result.photo_id).toBe(photoId)
})

// C3: Throws on non-2xx with worker error name surfaced
test('C3: detectPhoto throws with worker error name on non-2xx response', async () => {
  const { createPresignedGetUrl } = await import('@/lib/photos/r2')
  vi.mocked(createPresignedGetUrl).mockResolvedValueOnce('https://r2.example.com/presigned')

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({
        error: 'worker.detect.r2_fetch_failed',
        upstream_status: 0,
      }),
    }),
  )

  const { detectPhoto } = await import('@/lib/worker/client')

  await expect(detectPhoto('photo-uuid-789', 'events/E/preview/P.jpg')).rejects.toThrow(
    'worker.detect.r2_fetch_failed',
  )
})

// C4: 30s timeout — fetch that never resolves triggers rejection after 30s
test(
  'C4: detectPhoto rejects after 30s timeout',
  async () => {
    vi.useFakeTimers()

    const { createPresignedGetUrl } = await import('@/lib/photos/r2')
    // createPresignedGetUrl must resolve synchronously with fake timers so the
    // fetch is reached. Use a pre-resolved promise to avoid any timer dependency.
    vi.mocked(createPresignedGetUrl).mockResolvedValueOnce('https://r2.example.com/presigned')

    // Stub fetch to simulate a request that respects the AbortSignal
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          // When the AbortSignal fires, reject with an AbortError
          const signal = init?.signal as AbortSignal | undefined
          if (signal) {
            signal.addEventListener('abort', () => {
              reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
            })
          }
        })
      }),
    )

    const { detectPhoto } = await import('@/lib/worker/client')

    const detectPromise = detectPhoto('photo-uuid-timeout', 'events/E/preview/P.jpg')

    // Let the microtask queue drain so detectPhoto reaches the fetch call
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Advance 30 seconds to trigger AbortController.abort() via setTimeout,
    // then let microtasks propagate the rejection before asserting.
    await Promise.race([
      detectPromise.then(() => 'resolved').catch(() => 'rejected'),
      vi.advanceTimersByTimeAsync(30_000).then(() => 'timers-advanced'),
    ])
    // After advancing timers, the detectPromise should reject
    await expect(detectPromise).rejects.toThrow()
  },
  60_000,
)
