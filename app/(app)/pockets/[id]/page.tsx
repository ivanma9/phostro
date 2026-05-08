import { eq } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { MintShareLink } from '@/components/MintShareLink'
import { db } from '@/db'
import { events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { getFaceEmbeddings, getFaceEnrollment } from '@/lib/auth/face-enrollment'
import { createPresignedGetUrl } from '@/lib/photos/r2'
import { listYouFeed } from '@/lib/photos/you-feed'

const PREVIEW_URL_TTL_SECONDS = 5 * 60

export default async function PocketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const user = await getCurrentUser()
  if (!user) redirect(`/auth/signin?next=/pockets/${id}`)

  const [event] = await db.select().from(events).where(eq(events.id, id))
  if (!event) notFound()

  if (event.hostUserId !== user.id) redirect('/')

  const enrollment = await getFaceEnrollment(user.id)

  let feedPhotos: Array<{
    photoId: string
    previewUrl: string
    distance: number
    takenAt: Date | null
  }> = []

  if (enrollment.enrolled) {
    const embeddings = (await getFaceEmbeddings(user.id)).map((e) => e.embedding)
    const items = await listYouFeed(event.id, embeddings)
    feedPhotos = await Promise.all(
      items.map(async (item) => ({
        photoId: item.photoId,
        previewUrl: await createPresignedGetUrl(item.r2KeyPreview, PREVIEW_URL_TTL_SECONDS),
        distance: item.distance,
        takenAt: item.takenAt,
      })),
    )
  }

  const enrolled = enrollment.enrolled
  const enrollHref = `/me/face/enroll?next=${encodeURIComponent(`/pockets/${id}`)}`

  return (
    <main className="mx-auto max-w-md p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{event.name}</h1>
        <MintShareLink pocketId={event.id} />
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-medium">
          Your photos ({enrolled ? feedPhotos.length : '—'})
        </h2>

        {!enrolled ? (
          <div className="space-y-2">
            <p className="text-sm text-gray-500">
              Set up face matching with a quick 3-angle scan
              {enrollment.enrolledAngles.length > 0
                ? ` (${enrollment.enrolledAngles.length} of 3 done)`
                : ''}
              .
            </p>
            <Link href={enrollHref} className="inline-block rounded border px-3 py-2 text-sm">
              {enrollment.enrolledAngles.length > 0 ? 'Continue your scan' : 'Start face scan'}
            </Link>
          </div>
        ) : feedPhotos.length === 0 ? (
          <p className="text-sm text-gray-500">
            No photos yet. Share your link to start receiving photos.
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-2">
            {feedPhotos.map((p) => (
              <li key={p.photoId}>
                <a href={`/api/photos/${p.photoId}/original`} target="_blank" rel="noreferrer">
                  {/* biome-ignore lint/performance/noImgElement: presigned R2 URL; next/image incompatible with signed query params */}
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
