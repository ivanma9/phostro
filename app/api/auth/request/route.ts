import { NextResponse } from 'next/server'
import { db } from '@/db'
import { magicLinkTokens } from '@/db/schema'
import { generateToken, hashToken } from '@/lib/auth/tokens'
import { sendMagicLinkEmail } from '@/lib/email'

export async function POST(req: Request) {
  const { contact, name } = (await req.json()) as { contact?: unknown; name?: unknown }
  if (!contact || typeof contact !== 'string' || !contact.includes('@')) {
    return NextResponse.json({ error: 'invalid contact' }, { status: 400 })
  }
  const token = generateToken()
  const tokenHash = await hashToken(token)
  const lowered = contact.toLowerCase()

  await db.insert(magicLinkTokens).values({
    contact: lowered,
    contactType: 'email',
    intendedName: typeof name === 'string' ? name : null,
    tokenHash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  })

  const link = `${process.env.APP_URL}/api/auth/verify?token=${token}&contact=${encodeURIComponent(lowered)}`
  if (process.env.NODE_ENV !== 'test' && process.env.RESEND_API_KEY) {
    await sendMagicLinkEmail({ to: lowered, link })
  }
  return NextResponse.json({ ok: true })
}
