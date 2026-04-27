import { createHash, randomBytes } from 'node:crypto'

// Magic-link tokens are 256-bit cryptographic randoms; SHA-256 storage is sufficient
// (preimage-resistant, no user-chosen entropy). We compare hashes via SQL `=` —
// timing leaks here would only reveal hash bytes, not the secret token.

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export async function hashToken(token: string): Promise<string> {
  return createHash('sha256').update(token).digest('hex')
}
