import { and, eq, gt, isNull } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { magicLinkTokens, users } from '@/db/schema'
import { safeNext } from '@/lib/auth/redirect'
import { getSession } from '@/lib/auth/session'
import { hashToken } from '@/lib/auth/tokens'

const errorRedirect = () => NextResponse.redirect(`${process.env.APP_URL}/auth/error`)

export async function GET(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  const contact = url.searchParams.get('contact')?.toLowerCase()
  if (!token || !contact) return errorRedirect()

  const tokenHash = await hashToken(token)

  // Atomic consumption: SELECT + UPDATE collapsed so two concurrent verifies
  // (mail-client prefetch, double-click) can't both pass the unconsumed check.
  const [row] = await db
    .update(magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(magicLinkTokens.contact, contact),
        eq(magicLinkTokens.tokenHash, tokenHash),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, new Date()),
      ),
    )
    .returning()
  if (!row) return errorRedirect()

  const [existing] = await db.select().from(users).where(eq(users.contact, contact))
  let user = existing
  if (!user) {
    ;[user] = await db
      .insert(users)
      .values({
        name: row.intendedName ?? contact,
        contact,
        contactType: 'email',
      })
      .onConflictDoNothing({ target: users.contact })
      .returning()
    if (!user) {
      ;[user] = await db.select().from(users).where(eq(users.contact, contact))
    }
  }

  const session = await getSession()
  session.userId = user.id
  await session.save()

  const target = safeNext(row.intendedRedirect) ?? '/'
  return NextResponse.redirect(`${process.env.APP_URL}${target}`)
}
