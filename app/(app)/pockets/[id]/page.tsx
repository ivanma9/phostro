// TODO: desktop two-column variant per screens-misc.jsx::DesktopPocketDetail
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { MintShareLink } from '@/components/MintShareLink'
import { db } from '@/db'
import { events, photoJobs, photos, shareLinks } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { getFaceEmbeddings, getFaceEnrollment } from '@/lib/auth/face-enrollment'
import { createPresignedGetUrl } from '@/lib/photos/r2'
import { listYouFeed } from '@/lib/photos/you-feed'
import { AppBar } from '@/components/ui/AppBar'
import { Eyebrow } from '@/components/ui/Eyebrow'
import { LiveCountdown } from '@/components/ui/LiveCountdown'
import { PhotoTile } from '@/components/ui/PhotoTile'
import { GalleryEmptyIllo } from '@/components/ui/GalleryEmptyIllo'
import { ShareBlock } from '@/components/ui/ShareBlock'
import { I } from '@/components/ui/Icon'
import { ToastProvider } from '@/components/ui/Toast'

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

  // Count photo_jobs that are still being processed for this pocket. Used to
  // surface "still analyzing" copy so the owner doesn't think (Your photos: 0)
  // is a final state when there are uploads still in flight.
  const [{ pending }] = await db
    .select({ pending: count() })
    .from(photoJobs)
    .where(
      and(
        inArray(photoJobs.state, ['queued', 'claimed']),
        sql`${photoJobs.photoId} IN (SELECT id FROM ${photos} WHERE event_id = ${event.id})`,
      ),
    )

  // All-photos view (v0 hotfix). Owner needs visibility into everything contributors
  // uploaded, not just face matches — otherwise "I uploaded photos but where are
  // they?" friction. Hide photos that already appear in You feed to avoid duplication.
  const youFeedIds = new Set(feedPhotos.map((p) => p.photoId))
  const allPhotosRaw = await db
    .select({
      id: photos.id,
      r2KeyPreview: photos.r2KeyPreview,
      uploadedAt: photos.uploadedAt,
    })
    .from(photos)
    .where(
      and(
        eq(photos.eventId, event.id),
        eq(photos.processingState, 'ready'),
        isNull(photos.deletedAt),
      ),
    )
    .orderBy(desc(photos.uploadedAt))
  const otherPhotos = await Promise.all(
    allPhotosRaw
      .filter((p) => p.r2KeyPreview && !youFeedIds.has(p.id))
      .map(async (p) => ({
        photoId: p.id,
        previewUrl: await createPresignedGetUrl(p.r2KeyPreview as string, PREVIEW_URL_TTL_SECONDS),
      })),
  )

  // Derive expiry state for near-expiry banner and expired view
  const now = new Date()
  const isExpired = event.expiresAt < now
  const diffMs = Math.max(0, event.expiresAt.getTime() - now.getTime())
  const daysLeft = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const isNearExpiry = !isExpired && daysLeft === 0

  // Format expiry time for banner (e.g. "9:48 pm")
  const expiryTimeStr = event.expiresAt.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  // Format expired date for expired state (e.g. "Sat, May 4")
  const expiredDateStr = event.expiresAt.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })

  // Fetch the most recent active share link to drive ShareBlock url + remaining count.
  // We only query for display — minting/revoking happens client-side via MintShareLink.
  const [activeShareLink] = await db
    .select({
      id: shareLinks.id,
      tokenHash: shareLinks.tokenHash,
      maxUploads: shareLinks.maxUploads,
      uploadCount: shareLinks.uploadCount,
      revokedAt: shareLinks.revokedAt,
    })
    .from(shareLinks)
    .where(eq(shareLinks.eventId, event.id))
    .orderBy(desc(shareLinks.createdAt))
    .limit(1)

  // Build remaining string: "uploadCount / maxUploads" when maxUploads is set
  // TODO: expose the share token plaintext via a separate lookup so we can build
  // the full share URL here. For now fall through to the MintShareLink children slot.
  const remainingStr =
    activeShareLink?.maxUploads != null
      ? `${activeShareLink.uploadCount} / ${activeShareLink.maxUploads}`
      : undefined

  const photoCount = feedPhotos.length + otherPhotos.length

  // TODO: derive contributors count from distinct uploader_token / uploader_user_id
  // in photos table. Skipped in v1 — query requires a subquery + distinct that's low
  // priority. Falling back to "—".
  const contribsDisplay = '—'

  // ── Name split: last word is italic terracotta (PocketHeader design pattern) ──
  const nameParts = event.name.trim().split(/\s+/)
  const nameHead = nameParts.slice(0, -1).join(' ')
  const nameTail = nameParts[nameParts.length - 1]

  // ── Expired state (read-only) ──────────────────────────────────────────────
  if (isExpired) {
    return (
      <ToastProvider>
      <div>
        <AppBar
          leading={
            <Link href="/" style={{ display: 'flex', alignItems: 'center', padding: 4 }}>
              <I name="back" size={20} />
            </Link>
          }
          title={event.name}
        />
        <div style={{ padding: '8px 20px 18px', textAlign: 'center' }}>
          <Eyebrow>Read-only</Eyebrow>
          <h1
            className="display"
            style={{ fontSize: 36, lineHeight: 1.05, margin: '6px 0 4px', color: 'var(--muted)' }}
          >
            {nameHead ? `${nameHead} ` : ''}
            <em className="display-it" style={{ color: 'var(--muted)' }}>
              {nameTail}
            </em>
          </h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 6 }}>
            Expired {expiredDateStr} ·{' '}
            <span className="num">{photoCount}</span> photos archived for you.
          </p>
          {/* TODO: wire to /api/pockets/{id}/zip once that endpoint exists */}
          <a
            href="#"
            className="btn btn-accent btn-block"
            style={{ marginTop: 18, minHeight: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, textDecoration: 'none' }}
          >
            {/* TODO: ZIP endpoint not yet implemented */}
            <I name="download" size={16} /> Download final ZIP
          </a>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
            Available for 7 more days, then the ZIP is deleted too.
          </p>
        </div>
        {(feedPhotos.length > 0 || otherPhotos.length > 0) && (
          <div className="grid-3" style={{ padding: '0 20px', gap: 3 }}>
            {[...feedPhotos, ...otherPhotos].map((p) => (
              <a
                key={p.photoId}
                href={`/api/photos/${p.photoId}/original`}
                target="_blank"
                rel="noreferrer"
              >
                {/* biome-ignore lint/performance/noImgElement: presigned R2 URL; next/image incompatible with signed query params */}
                <img
                  src={p.previewUrl}
                  alt=""
                  loading="lazy"
                  style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block', filter: 'brightness(.6)' }}
                />
              </a>
            ))}
          </div>
        )}
      </div>
      </ToastProvider>
    )
  }

  // ── Active state ───────────────────────────────────────────────────────────
  return (
    <ToastProvider>
    <div>
      {/* ── Near-expiry banner ── */}
      {isNearExpiry && (
        <div
          style={{
            margin: '12px 20px 0',
            padding: '12px 14px',
            background: 'var(--t-alarm-bg)',
            border: '1px solid rgba(154,48,39,.18)',
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <I name="clock" size={18} style={{ color: 'var(--t-alarm)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-alarm)' }}>
              Expires today.
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--t-alarm)', opacity: 0.85 }}>
              Download your ZIP before <span className="num">{expiryTimeStr}</span>.
            </div>
          </div>
          {/* TODO: wire to /api/pockets/{id}/zip once that endpoint exists */}
          <a
            href="#"
            className="btn btn-sm"
            style={{ background: 'var(--t-alarm)', color: '#FFF8EE', minHeight: 32, textDecoration: 'none' }}
          >
            ZIP now
          </a>
        </div>
      )}

      {/* ── AppBar ── */}
      <AppBar
        leading={
          <Link href="/" style={{ display: 'flex', alignItems: 'center', padding: 4 }}>
            <I name="back" size={20} />
          </Link>
        }
        title={event.name}
        trailing={
          <button
            type="button"
            style={{ background: 'none', border: 0, padding: 4, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
            aria-label="More options"
          >
            <I name="more" size={20} />
          </button>
        }
      />

      {/* ── Editorial header ── */}
      <div style={{ padding: '8px 20px 18px' }}>
        <Eyebrow>A pocket of memories</Eyebrow>
        <h1
          className="display"
          style={{ fontSize: 38, lineHeight: 1.0, letterSpacing: '-0.02em', margin: '6px 0 2px' }}
        >
          {nameHead ? `${nameHead} ` : ''}
          <em className="display-it" style={{ color: 'var(--accent)' }}>
            {nameTail}
          </em>
        </h1>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
          <span className="num">{photoCount}</span> photos ·{' '}
          <span className="num">{contribsDisplay}</span> contributors
        </div>

        {/* Countdown card */}
        <div
          style={{
            marginTop: 18,
            padding: '14px 16px',
            background: 'var(--paper-2)',
            borderRadius: 14,
            border: '1px solid var(--rule-soft)',
          }}
        >
          <LiveCountdown expiresAtMs={event.expiresAt.getTime()} />
        </div>
      </div>

      {/* ── Action row ── */}
      <div style={{ display: 'flex', gap: 8, padding: '0 20px' }}>
        {/* Upload: not wired — host upload flow is its own feature */}
        <button type="button" className="btn btn-accent flex-1">
          <I name="upload" size={16} /> Upload
        </button>
        {/* TODO: wire to /api/pockets/{id}/zip once that endpoint exists */}
        <a
          href="#"
          className="btn btn-ghost flex-1"
          style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          <I name="download" size={16} /> Download ZIP
        </a>
      </div>

      {/* ── Share block ── */}
      <div style={{ padding: '22px 20px 0' }}>
        <Eyebrow>Share your pocket</Eyebrow>
        <div style={{ marginTop: 10 }}>
          {/* ShareBlock renders `children` slot when no URL is available yet.
              MintShareLink mints + copies a share URL client-side. The page reloads
              after mint so the host sees the QR on next visit. For Phase 6 we keep
              the simpler slot pattern — wiring SSR'd share URL requires exposing
              the plaintext token, which needs a separate lookup (TODO). */}
          <ShareBlock remaining={remainingStr}>
            <MintShareLink pocketId={event.id} />
          </ShareBlock>
        </div>
      </div>

      {/* ── Face-enroll banner ── */}
      {!enrolled && (
        <div
          style={{
            margin: '22px 20px 0',
            padding: '18px 18px 18px',
            background: 'var(--paper-2)',
            borderRadius: 14,
            border: '1px solid var(--rule-soft)',
          }}
        >
          <Eyebrow>Set up your face</Eyebrow>
          <div
            className="display"
            style={{ fontSize: 20, lineHeight: 1.1, margin: '6px 0 6px' }}
          >
            Match yourself in{' '}
            <em className="display-it" style={{ color: 'var(--accent)' }}>
              your photos
            </em>
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 2 }}>
            Quick 3-angle scan.{' '}
            {enrollment.enrolledAngles.length > 0
              ? `${enrollment.enrolledAngles.length} of 3 done.`
              : 'Takes about 30 seconds.'}
          </p>
          <Link href={enrollHref} className="btn btn-primary" style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
            {enrollment.enrolledAngles.length > 0 ? 'Continue scan' : 'Start face scan'}
          </Link>
        </div>
      )}

      {/* ── Your photos gallery ── */}
      <div style={{ padding: '28px 20px 0' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 className="display" style={{ fontSize: 22 }}>Gallery</h2>
          <button
            type="button"
            style={{ background: 'none', border: 0, color: 'var(--muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
          >
            <I name="grid" size={12} /> Grid · all
          </button>
        </div>

        {!enrolled ? null : feedPhotos.length === 0 ? (
          pending > 0 ? (
            /* Still analyzing */
            <div
              style={{
                padding: '24px',
                border: '1px dashed var(--rule)',
                borderRadius: 14,
                textAlign: 'center',
                background: 'var(--surface)',
              }}
            >
              <div className="display" style={{ fontSize: 20, lineHeight: 1.1 }}>
                Still analyzing
              </div>
              <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 4 }}>
                {pending} {pending === 1 ? 'photo' : 'photos'} in queue. Reload in ~30 seconds.
              </p>
            </div>
          ) : (
            /* Empty state */
            <div
              style={{
                padding: 24,
                border: '1px dashed var(--rule)',
                borderRadius: 14,
                textAlign: 'center',
                background: 'var(--surface)',
              }}
            >
              <GalleryEmptyIllo />
              <div className="display" style={{ fontSize: 22, lineHeight: 1.1, marginTop: 8 }}>
                Waiting for photos
              </div>
              <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 4 }}>
                The link above unlocks uploads for anyone — no signup needed.
              </p>
            </div>
          )
        ) : (
          <div className="grid-3" style={{ gap: 3 }}>
            {feedPhotos.map((p) => (
              <a
                key={p.photoId}
                href={`/api/photos/${p.photoId}/original`}
                target="_blank"
                rel="noreferrer"
                style={{ display: 'block' }}
              >
                <PhotoTile src={p.previewUrl} />
              </a>
            ))}
          </div>
        )}
      </div>

      {/* ── All contributions ── */}
      {otherPhotos.length > 0 && (
        <div style={{ padding: '28px 20px 32px', borderTop: '1px solid var(--rule)', marginTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
            <Eyebrow>All contributions</Eyebrow>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              <span className="num">{otherPhotos.length}</span>
            </span>
          </div>
          <p style={{ marginBottom: 12, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            Photos contributors uploaded that the matcher didn&rsquo;t link to your face.
          </p>
          <div className="grid-3" style={{ gap: 3 }}>
            {otherPhotos.map((p) => (
              <a
                key={p.photoId}
                href={`/api/photos/${p.photoId}/original`}
                target="_blank"
                rel="noreferrer"
                style={{ display: 'block' }}
              >
                {/* biome-ignore lint/performance/noImgElement: presigned R2 URL; next/image incompatible with signed query params */}
                <img
                  src={p.previewUrl}
                  alt=""
                  loading="lazy"
                  style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block' }}
                />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* ── Desktop layout (≥1024px): two-column via CSS module override ──────
          The lg: classes below activate on large viewports. Contributors aside
          is a placeholder — distinct contributor data is not yet aggregated
          server-side. TODO: query distinct uploader_token + count for aside. */}
    </div>
    </ToastProvider>
  )
}
