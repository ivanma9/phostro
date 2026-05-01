export type UploadProgress = { done: number; total: number; failed: number }

type UploadResult = { ok: true; photoId: string } | { ok: false; reason: string }

export async function uploadOne(eventId: string, file: File): Promise<UploadResult> {
  const initRes = await fetch(`/api/events/${eventId}/photos/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    }),
  })
  if (!initRes.ok) {
    return { ok: false, reason: `init failed (${initRes.status})` }
  }
  const { photoId, putUrl } = (await initRes.json()) as { photoId: string; putUrl: string }

  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  if (!putRes.ok) {
    return { ok: false, reason: `upload failed (${putRes.status})` }
  }

  const finRes = await fetch(`/api/events/${eventId}/photos/${photoId}/finalize`, {
    method: 'POST',
  })
  if (!finRes.ok) {
    return { ok: false, reason: `finalize failed (${finRes.status})` }
  }
  return { ok: true, photoId }
}

export async function uploadBatch(
  eventId: string,
  files: File[],
  concurrency: number,
  onProgress: (p: UploadProgress) => void,
): Promise<UploadResult[]> {
  const results: UploadResult[] = []
  let done = 0
  let failed = 0
  let i = 0
  const total = files.length

  async function worker() {
    while (i < total) {
      const idx = i++
      const r = await uploadOne(eventId, files[idx]).catch(
        (e): UploadResult => ({ ok: false, reason: String(e) }),
      )
      results[idx] = r
      done++
      if (!r.ok) failed++
      onProgress({ done, total, failed })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))
  return results
}
