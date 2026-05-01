import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { users } from '@/db/schema'
import { getSession } from '@/lib/auth/session'

export async function POST(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const body = (await req.json()) as {
    contact?: unknown
    name?: unknown
  }

  const contact = typeof body.contact === 'string' ? body.contact.toLowerCase() : null
  if (!contact?.includes('@')) {
    return NextResponse.json({ error: 'invalid contact' }, { status: 400 })
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : contact

  let [user] = await db.select().from(users).where(eq(users.contact, contact))
  if (!user) {
    ;[user] = await db.insert(users).values({ name, contact, contactType: 'email' }).returning()
  }

  const session = await getSession()
  session.userId = user.id
  await session.save()

  return NextResponse.json({ user: { id: user.id, name: user.name, contact: user.contact } })
}
