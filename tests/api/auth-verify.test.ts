import { eq } from 'drizzle-orm'
import { beforeEach, expect, test, vi } from 'vitest'
import { GET as verify } from '@/app/api/auth/verify/route'
import { db } from '@/db'
import { magicLinkTokens, users } from '@/db/schema'
import { generateToken, hashToken } from '@/lib/auth/tokens'

vi.mock('@/lib/auth/session', () => {
  const session = { userId: undefined as string | undefined, save: vi.fn(), destroy: vi.fn() }
  return {
    getSession: vi.fn(async () => {
      session.save = vi.fn()
      return session
    }),
    __session: session,
  }
})

beforeEach(async () => {
  await db.delete(magicLinkTokens)
  await db.delete(users)
})

async function seedToken(contact: string, name: string) {
  const raw = generateToken()
  const hash = await hashToken(raw)
  await db.insert(magicLinkTokens).values({
    contact,
    contactType: 'email',
    intendedName: name,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  })
  return raw
}

test('verify creates new user and consumes token', async () => {
  const raw = await seedToken('a@b.com', 'Alice')
  const res = await verify(new Request(`http://test/api/auth/verify?token=${raw}&contact=a@b.com`))
  expect(res.status).toBe(307)
  const [u] = await db.select().from(users).where(eq(users.contact, 'a@b.com'))
  expect(u.name).toBe('Alice')
  const [t] = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.contact, 'a@b.com'))
  expect(t.consumedAt).not.toBeNull()
})

test('verify reuses existing user', async () => {
  await db.insert(users).values({ name: 'Existing', contact: 'a@b.com', contactType: 'email' })
  const raw = await seedToken('a@b.com', 'NewName')
  await verify(new Request(`http://test/api/auth/verify?token=${raw}&contact=a@b.com`))
  const rows = await db.select().from(users).where(eq(users.contact, 'a@b.com'))
  expect(rows).toHaveLength(1)
  expect(rows[0].name).toBe('Existing')
})

test('verify redirects to error page on invalid token', async () => {
  const res = await verify(new Request('http://test/api/auth/verify?token=bogus&contact=x@y.com'))
  expect(res.status).toBe(307)
  expect(res.headers.get('location')).toContain('/auth/error')
})

test('verify rejects expired token', async () => {
  const raw = generateToken()
  const hash = await hashToken(raw)
  await db.insert(magicLinkTokens).values({
    contact: 'c@d.com',
    contactType: 'email',
    tokenHash: hash,
    expiresAt: new Date(Date.now() - 1000),
  })
  const res = await verify(new Request(`http://test/api/auth/verify?token=${raw}&contact=c@d.com`))
  expect(res.headers.get('location')).toContain('/auth/error')
})
