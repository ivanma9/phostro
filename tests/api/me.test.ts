import { beforeEach, expect, test, vi } from 'vitest'
import { GET } from '@/app/api/me/route'
import { db } from '@/db'
import { users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

beforeEach(async () => {
  await db.delete(users)
  vi.restoreAllMocks()
})

test('returns 401 when no session', async () => {
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
  const res = await GET()
  expect(res.status).toBe(401)
  const body = await res.json()
  expect(body.user).toBeNull()
})

test('returns user payload when authenticated', async () => {
  const [u] = await db
    .insert(users)
    .values({ name: 'Alice', contact: 'a@b.com', contactType: 'email' })
    .returning()
  vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(u)
  const res = await GET()
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.user).toEqual({ id: u.id, name: 'Alice', contact: 'a@b.com' })
})
