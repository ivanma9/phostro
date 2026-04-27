import { expect, test } from 'vitest'
import { generateToken, hashToken } from '@/lib/auth/tokens'

test('generates a 32-byte hex token', () => {
  const t = generateToken()
  expect(t).toMatch(/^[a-f0-9]{64}$/)
})

test('hashToken produces the same SHA-256 hex for the same input', async () => {
  const t = generateToken()
  expect(await hashToken(t)).toBe(await hashToken(t))
})

test('hashToken differs from input', async () => {
  const t = generateToken()
  expect(await hashToken(t)).not.toBe(t)
})
