import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { users } from '@/db/schema'
import { getSession } from '@/lib/auth/session'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  // NODE_ENV is forced to 'development' by `next dev`, so also accept E2E=1
  if (process.env.NODE_ENV !== 'test' && process.env.E2E !== '1') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { contact, name } = (await req.json()) as { contact?: string; name?: string }
  if (!contact || !name) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
  const [existing] = await db.select().from(users).where(eq(users.contact, contact.toLowerCase()))
  let user = existing
  if (!user) {
    ;[user] = await db
      .insert(users)
      .values({ name, contact: contact.toLowerCase(), contactType: 'email' })
      .returning()
  }
  const session = await getSession()
  session.userId = user.id
  await session.save()
  return NextResponse.json({ user: { id: user.id, name: user.name } })
}
