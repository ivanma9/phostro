import { expect, test } from 'vitest'
import { generateToken, hashToken, verifyToken } from '@/lib/auth/tokens'

test('generates a 32-byte hex token', () => {
  const t = generateToken()
  expect(t).toMatch(/^[a-f0-9]{64}$/)
})

test('hashes and verifies a token', async () => {
  const t = generateToken()
  const h = await hashToken(t)
  expect(h).not.toBe(t)
  expect(await verifyToken(t, h)).toBe(true)
  expect(await verifyToken('wrong', h)).toBe(false)
})
