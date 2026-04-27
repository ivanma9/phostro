import { and, eq } from 'drizzle-orm'
import { notFound, redirect } from 'next/navigation'
import { ShareLink } from '@/components/ShareLink'
import { db } from '@/db'
import { eventMembers, events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) redirect('/auth/signin')

  const [event] = await db.select().from(events).where(eq(events.id, id))
  if (!event) notFound()

  const [membership] = await db
    .select()
    .from(eventMembers)
    .where(and(eq(eventMembers.eventId, id), eq(eventMembers.userId, user.id)))
  if (!membership) redirect('/')

  const link = `${process.env.APP_URL}/events/${event.id}/join`

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-2xl font-semibold">{event.name}</h1>
      <p className="text-sm text-gray-500">
        Expires {new Date(event.expiresAt).toLocaleDateString()}
      </p>
      <ShareLink url={link} />
    </main>
  )
}
