import { getIronSession, type IronSession } from 'iron-session'
import { cookies } from 'next/headers'

export type SessionData = { userId?: string }

export async function getSession(): Promise<IronSession<SessionData>> {
  const password = process.env.SESSION_SECRET
  if (!password) throw new Error('SESSION_SECRET is not set')
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
