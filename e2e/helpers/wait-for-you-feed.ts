import type { APIRequestContext } from '@playwright/test'

/**
 * Polls GET /api/pockets/[pocketId]/you every 500ms until `photos.length >= expectedMinCount`
 * or the hard cap of `timeoutMs` (default 30s) is hit.
 *
 * Transient non-ok responses are retried silently. The function throws with a
 * descriptive message if the cap is hit — no waitForTimeout anywhere.
 *
 * CI note: the host session cookie must be attached to `request`. Pass the
 * `page.request` from the host's browser context, not the contributor's.
 */
export async function waitForYouFeedPhotos(
  request: APIRequestContext,
  eventId: string,
  expectedMinCount: number,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now()
  let lastCount = -1

  while (Date.now() - started < timeoutMs) {
    const res = await request.get(`/api/pockets/${eventId}/you`)
    if (!res.ok()) {
      // Transient error (e.g. 503 while server warms up) — retry
      await new Promise((r) => setTimeout(r, 500))
      continue
    }
    const body = (await res.json()) as { photos: unknown[] }
    lastCount = body.photos.length
    if (lastCount >= expectedMinCount) return
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new Error(
    `You feed did not reach >= ${expectedMinCount} photos within ${timeoutMs}ms (last count: ${lastCount})`,
  )
}
