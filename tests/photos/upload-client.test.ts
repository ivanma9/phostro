import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { uploadBatch, uploadOne } from '@/lib/photos/upload-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function file(name = 'a.jpg', size = 100) {
  return new File([new Uint8Array(size)], name, { type: 'image/jpeg' })
}

test('uploadOne happy path', async () => {
  fetchMock
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ photoId: 'P', putUrl: 'http://r2/p' }), { status: 200 }),
    )
    .mockResolvedValueOnce(new Response('', { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ photo: {} }), { status: 200 }))
  const r = await uploadOne('E', file())
  expect(r).toEqual({ ok: true, photoId: 'P' })
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

test('uploadOne returns failure on init 4xx', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 413 }))
  const r = await uploadOne('E', file())
  expect(r.ok).toBe(false)
})

test('uploadBatch reports aggregate progress', async () => {
  fetchMock.mockImplementation((_url: string, init?: { method?: string }) => {
    if (init?.method === 'POST' && (_url as string).endsWith('/init')) {
      return Promise.resolve(
        new Response(JSON.stringify({ photoId: crypto.randomUUID(), putUrl: 'http://r2/p' }), {
          status: 200,
        }),
      )
    }
    return Promise.resolve(new Response(JSON.stringify({ photo: {} }), { status: 200 }))
  })
  const seen: number[] = []
  const r = await uploadBatch('E', [file(), file(), file(), file()], 3, (p) => seen.push(p.done))
  expect(r.every((x) => x.ok)).toBe(true)
  expect(seen[seen.length - 1]).toBe(4)
})
