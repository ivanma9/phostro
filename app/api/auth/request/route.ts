import { after, NextResponse } from 'next/server'
import { db } from '@/db'
import { magicLinkTokens } from '@/db/schema'
import { safeNext } from '@/lib/auth/redirect'
import { generateToken, hashToken } from '@/lib/auth/tokens'
import { sendMagicLinkEmail } from '@/lib/email'

const NAME_MAX = 100

export async function POST(req: Request) {
  const body = (await req.json()) as {
    contact?: unknown
    name?: unknown
    next?: unknown
  }

  const contact = body.contact
  if (!contact || typeof contact !== 'string' || !contact.includes('@')) {
    return NextResponse.json({ error: 'invalid contact' }, { status: 400 })
  }

  if (process.env.NODE_ENV === 'production' && !process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY missing in production; refusing to send magic link')
    return NextResponse.json({ error: 'service unavailable' }, { status: 503 })
  }

  const lowered = contact.toLowerCase()
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : null
  const intendedRedirect = safeNext(body.next)

  const token = generateToken()
  const tokenHash = await hashToken(token)

  await db.insert(magicLinkTokens).values({
    contact: lowered,
    contactType: 'email',
    intendedName: name,
    intendedRedirect,
    tokenHash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  })

  const link = `${process.env.APP_URL}/api/auth/verify?token=${token}&contact=${encodeURIComponent(lowered)}`
  if (process.env.NODE_ENV !== 'test' && process.env.RESEND_API_KEY) {
    // Send after the response so we don't block on Resend (3-4s) and don't leak
    // deliverability via 500s. after() extends the serverless invocation via
    // waitUntil so the send isn't terminated when the response is returned.
    after(async () => {
      try {
        await sendMagicLinkEmail({ to: lowered, link })
      } catch (err) {
        console.error('sendMagicLinkEmail failed', { contact: lowered, err })
      }
    })
  }
  return NextResponse.json({ ok: true })
}
