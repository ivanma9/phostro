import { and, eq } from 'drizzle-orm'
import { notFound, redirect } from 'next/navigation'
import { ShareLink } from '@/components/ShareLink'
import { UploadDropzone } from '@/components/UploadDropzone'
import { db } from '@/db'
import { eventMembers, events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { listMyPhotos } from '@/lib/photos/gallery'

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
  const myPhotos = await listMyPhotos(event.id, user.id)

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-2xl font-semibold">{event.name}</h1>
      <p className="text-sm text-gray-500">
        Expires {new Date(event.expiresAt).toLocaleDateString()}
      </p>
      <ShareLink url={link} />

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-medium">Add photos</h2>
        <UploadDropzone eventId={event.id} />
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-medium">Your uploads ({myPhotos.length})</h2>
        {myPhotos.length === 0 ? (
          <p className="text-sm text-gray-500">No uploads yet.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2">
            {myPhotos.map((p) => (
              <li key={p.id}>
                <a href={`/api/photos/${p.id}/original`} target="_blank" rel="noreferrer">
                  {/* biome-ignore lint/performance/noImgElement: Phase 2: presigned R2 URL; next/image incompatible with signed query params */}
                  <img
                    src={p.previewUrl}
                    alt=""
                    loading="lazy"
                    className="aspect-square w-full rounded object-cover"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
