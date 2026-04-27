import { and, eq, gt, isNull } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { magicLinkTokens, users } from '@/db/schema'
import { getSession } from '@/lib/auth/session'
import { hashToken } from '@/lib/auth/tokens'

const errorRedirect = () => NextResponse.redirect(`${process.env.APP_URL}/auth/error`)

export async function GET(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  const contact = url.searchParams.get('contact')?.toLowerCase()
  if (!token || !contact) return errorRedirect()

  const tokenHash = await hashToken(token)
  const [row] = await db
    .select()
    .from(magicLinkTokens)
    .where(
      and(
        eq(magicLinkTokens.contact, contact),
        eq(magicLinkTokens.tokenHash, tokenHash),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, new Date()),
      ),
    )
  if (!row) return errorRedirect()

  await db
    .update(magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(eq(magicLinkTokens.id, row.id))

  let [user] = await db.select().from(users).where(eq(users.contact, contact))
  if (!user) {
    ;[user] = await db
      .insert(users)
      .values({
        name: row.intendedName ?? contact,
        contact,
        contactType: 'email',
      })
      .returning()
  }

  const session = await getSession()
  session.userId = user.id
  await session.save()
  return NextResponse.redirect(`${process.env.APP_URL}/`)
}
