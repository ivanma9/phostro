import { and, desc, eq, gt } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { db } from '@/db'
import { eventMembers, events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'

export default async function Home() {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/signin')

  const rows = await db
    .select({ event: events, role: eventMembers.role })
    .from(eventMembers)
    .innerJoin(events, eq(events.id, eventMembers.eventId))
    .where(and(eq(eventMembers.userId, user.id), gt(events.expiresAt, new Date())))
    .orderBy(desc(events.createdAt))

  return (
    <main className="mx-auto w-full max-w-md p-6">
      <h1 className="mb-4 text-2xl font-semibold">Your pockets</h1>
      <Link href="/pockets/new" className="mb-4 block rounded border px-3 py-2">
        + New pocket
      </Link>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No pockets yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ event, role }) => (
            <li key={event.id}>
              <Link href={`/pockets/${event.id}`} className="block rounded border px-3 py-2">
                {event.name} <span className="text-xs text-gray-500">({role})</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
