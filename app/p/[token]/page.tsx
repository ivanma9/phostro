import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { ContributorFrame } from '@/components/ContributorFrame'
import { Eyebrow } from '@/components/ui/Eyebrow'
import { Icon } from '@/components/ui/Icon'
import { Logo } from '@/components/ui/Logo'
import { ToastProvider } from '@/components/ui/Toast'
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
      <GuestShell>
        <div
          style={{
            padding: '40px 28px',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 99,
              background: 'var(--paper-2)',
              border: '1px solid var(--rule)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="lock" size={26} stroke={1.6} />
          </div>
          <Eyebrow>Limit reached</Eyebrow>
          <h2
            className="display"
            style={{ fontSize: 30, lineHeight: 1.05, margin: 0 }}
          >
            This share link is{' '}
            <em className="display-it" style={{ color: 'var(--accent)' }}>
              full
            </em>
            .
          </h2>
          <p
            style={{
              fontSize: 14,
              color: 'var(--muted)',
              lineHeight: 1.55,
              maxWidth: '34ch',
            }}
          >
            The host has set a limit on uploads, and we&rsquo;ve hit it. Ask
            them for a fresh link if you have more photos.
          </p>
        </div>
        <GuestPocketFooter />
      </GuestShell>
    )
  }

  if (!link) notFound()

  const [event] = await db
    .select({ id: events.id, name: events.name, hostUserId: events.hostUserId, expiresAt: events.expiresAt })
    .from(events)
    .where(eq(events.id, link.eventId))

  if (!event) notFound()

  const [host] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, event.hostUserId))

  const hostFirstName = host?.name?.split(' ')[0] ?? 'Someone'

  // Compute days remaining — fall back to "soon" if expiresAt unavailable
  let expiryText = 'soon'
  if (event.expiresAt) {
    const msLeft = new Date(event.expiresAt).getTime() - Date.now()
    const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)))
    expiryText = daysLeft === 0 ? 'today' : daysLeft === 1 ? '1 day' : `${daysLeft} days`
  }

  return (
    <ToastProvider>
      <GuestShell>
        {/* GuestHero */}
        <div style={{ padding: '6px 20px 8px' }}>
          <Eyebrow>A pocket from {hostFirstName}</Eyebrow>
          <h1
            className="display"
            style={{
              fontSize: 34,
              lineHeight: 1.0,
              letterSpacing: '-0.02em',
              margin: '6px 0 10px',
            }}
          >
            <em className="display-it" style={{ color: 'var(--accent)' }}>
              {hostFirstName}
            </em>{' '}
            wants your photos of{' '}
            <span style={{ whiteSpace: 'nowrap' }}>{event.name}</span>
          </h1>
          <p
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              lineHeight: 1.55,
            }}
          >
            Upload as many as you like — no account, no fuss. They expire with
            the pocket in{' '}
            <span className="num" style={{ color: 'var(--ink-soft)' }}>
              {expiryText}
            </span>
            .
          </p>
        </div>

        {/* Dashed dropzone card — transitions to full-width done state on upload complete */}
        <ContributorFrame
          token={token}
          eventName={event.name}
          hostFirstName={hostFirstName}
        />

        {/* Privacy micro-copy */}
        <div
          style={{
            padding: '20px 20px 8px',
            fontSize: 11.5,
            color: 'var(--muted)',
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          Photos go directly to {hostFirstName}&rsquo;s pocket and auto-delete
          in{' '}
          <span className="num" style={{ color: 'var(--ink-soft)' }}>
            {expiryText}
          </span>
          .
          <br />
          <a href="/tos" style={{ textDecoration: 'underline' }}>
            How Pocket handles privacy
          </a>
        </div>
      </GuestShell>
    </ToastProvider>
  )
}

function GuestShell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        maxWidth: 420,
        margin: '0 auto',
        minHeight: '100dvh',
        background: 'var(--paper)',
        display: 'flex',
        flexDirection: 'column',
        paddingBottom: 32,
      }}
    >
      <div style={{ padding: '14px 20px 8px' }}>
        <Logo size={18} />
      </div>
      {children}
    </main>
  )
}

function GuestPocketFooter() {
  return (
    <div
      style={{
        padding: '16px 28px',
        textAlign: 'center',
        fontSize: 11.5,
        color: 'var(--muted)',
        marginTop: 'auto',
      }}
    >
      <Logo size={16} /> ·{' '}
      <a href="https://pocket.app" style={{ textDecoration: 'underline' }}>
        pocket.app
      </a>
    </div>
  )
}
