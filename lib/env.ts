// Boot-time env validation. Called from `instrumentation.ts` so the server
// fails to start in production when required vars are missing or invalid.
// Defense-in-depth alongside lazy checks (e.g. lib/auth/session.ts) so misconfig
// surfaces at boot, not at the first user request.

const REQUIRED_ALWAYS = ['DATABASE_URL', 'SESSION_SECRET', 'APP_URL'] as const

const REQUIRED_IN_PRODUCTION = [
  'RESEND_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'WORKER_URL',
  'WORKER_SECRET',
] as const

const SESSION_SECRET_MIN_LEN = 32

export function validateEnv(): void {
  const missing: string[] = []

  for (const key of REQUIRED_ALWAYS) {
    if (!process.env[key]) missing.push(key)
  }

  if (process.env.NODE_ENV === 'production') {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!process.env[key]) missing.push(key)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `See .env.example for the full list.`,
    )
  }

  const secret = process.env.SESSION_SECRET
  if (secret && secret.length < SESSION_SECRET_MIN_LEN) {
    throw new Error(
      `SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LEN} characters ` +
        `(got ${secret.length}). Generate with: openssl rand -hex 32`,
    )
  }
}
