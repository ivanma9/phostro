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

test('uploadOne (token) happy path hits /api/p/[token]/ routes', async () => {
  fetchMock
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ photoId: 'P2', putUrl: 'http://r2/p2' }), { status: 200 }),
    )
    .mockResolvedValueOnce(new Response('', { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
  const r = await uploadOne({ kind: 'token', token: 'tok123' }, file())
  expect(r).toEqual({ ok: true, photoId: 'P2' })
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(fetchMock.mock.calls[0][0]).toBe('/api/p/tok123/init')
  expect(fetchMock.mock.calls[2][0]).toBe('/api/p/tok123/finalize/P2')
})

test('uploadOne (token) returns failure on init 4xx', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 410 }))
  const r = await uploadOne({ kind: 'token', token: 'tok123' }, file())
  expect(r.ok).toBe(false)
  expect((r as { ok: false; reason: string }).reason).toContain('410')
})

test('uploadBatch (token) reports progress and uses token routes', async () => {
  fetchMock.mockImplementation((_url: string, init?: { method?: string }) => {
    if (init?.method === 'POST' && (_url as string).endsWith('/init')) {
      return Promise.resolve(
        new Response(JSON.stringify({ photoId: crypto.randomUUID(), putUrl: 'http://r2/p' }), {
          status: 200,
        }),
      )
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
  })
  const seen: number[] = []
  const r = await uploadBatch({ kind: 'token', token: 'tok456' }, [file(), file()], 2, (p) =>
    seen.push(p.done),
  )
  expect(r.every((x) => x.ok)).toBe(true)
  expect(seen[seen.length - 1]).toBe(2)
  // All init calls should use token route
  const initCalls = fetchMock.mock.calls.filter(
    ([url, init]) => init?.method === 'POST' && (url as string).endsWith('/init'),
  )
  for (const [url] of initCalls) {
    expect(url).toMatch(/^\/api\/p\/tok456\/init$/)
  }
})
