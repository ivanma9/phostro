import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { ContributorUpload } from '@/components/ContributorUpload'
import { db } from '@/db'
import { events, users } from '@/db/schema'
import { ShareLinkError, verifyShareLink } from '@/lib/share-links/storage'

export default async function ContributorPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let link: Awaited<ReturnType<typeof verifyShareLink>> | undefined
  let exhausted = false

  try {
    link = await verifyShareLink(token)
  } catch (e) {
    if (e instanceof ShareLinkError) {
      if (e.code === 'invalid') notFound()
      if (e.code === 'exhausted') {
        exhausted = true
      } else {
        // revoked / expired — bubble to error.tsx
        throw e
      }
    } else {
      throw e
    }
  }

  if (exhausted) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-semibold">No more photos accepted.</h1>
        <p className="text-sm text-gray-500">This share link has reached its upload limit.</p>
      </main>
    )
  }

  if (!link) notFound()

  const [event] = await db
    .select({ id: events.id, name: events.name, hostUserId: events.hostUserId })
    .from(events)
    .where(eq(events.id, link.eventId))

  if (!event) notFound()

  const [host] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, event.hostUserId))

  const hostFirstName = host?.name?.split(' ')[0] ?? 'Someone'

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col gap-6 p-6">
      <p className="text-base text-gray-700">
        {hostFirstName} asked for {event.name} photos.
      </p>
      <ContributorUpload token={token} eventName={event.name} />
      <footer className="mt-auto text-center text-xs text-gray-400">
        <a href="/tos" className="underline">
          Terms of Service
        </a>
      </footer>
    </main>
  )
}
