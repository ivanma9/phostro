import { getIronSession, type IronSession } from 'iron-session'
import { cookies } from 'next/headers'

export type SessionData = { userId?: string }

const MIN_SESSION_SECRET_LEN = 32

export async function getSession (): Promise<IronSession<SessionData>> {
  const password = process.env.SESSION_SECRET
  if (!password) throw new Error('SESSION_SECRET is not set')
  if (password.length < MIN_SESSION_SECRET_LEN) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LEN} characters (iron-session). ` +
      'Generate one with: openssl rand -base64 32'
    )
  }
  return getIronSession<SessionData>(await cookies(), {
    password,
    cookieName: 'pc_session',
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
    },
  })
}
