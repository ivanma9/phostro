import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export async function hashToken(token: string): Promise<string> {
  return createHash('sha256').update(token).digest('hex')
}

export async function verifyToken(token: string, hash: string): Promise<boolean> {
  const tHash = await hashToken(token)
  if (tHash.length !== hash.length) return false
  return timingSafeEqual(Buffer.from(tHash), Buffer.from(hash))
}
