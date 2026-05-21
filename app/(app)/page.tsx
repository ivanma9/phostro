import { and, desc, eq, gt } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { db } from '@/db'
import { eventMembers, events } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { AppBar } from '@/components/ui/AppBar'
import { Eyebrow } from '@/components/ui/Eyebrow'
import { Logo } from '@/components/ui/Logo'
import { I } from '@/components/ui/Icon'
import { PocketCard } from '@/components/ui/PocketCard'
import { PocketEmptyIllo } from '@/components/ui/PocketEmptyIllo'

export default async function Home() {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/signin')

  const rows = await db
    .select({ event: events, role: eventMembers.role })
    .from(eventMembers)
    .innerJoin(events, eq(events.id, eventMembers.eventId))
    .where(and(eq(eventMembers.userId, user.id), gt(events.expiresAt, new Date())))
    .orderBy(desc(events.createdAt))

  // Derive user initial for avatar — fall back to "?" if name is empty
  const initial = (user.name ?? '').charAt(0).toLowerCase() || '?'

  const activeCount = rows.length

  const avatar = (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 99,
        background: 'var(--accent)',
        color: '#FFF8EE',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--display)',
        fontStyle: 'italic',
        fontSize: 15,
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  )

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      <AppBar leading={<Logo size={20} />} trailing={avatar} />

      {activeCount === 0 ? (
        <div style={{ padding: '12px 20px 24px', display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 56px)' }}>
          <Eyebrow>Welcome</Eyebrow>
          <h1
            className="display"
            style={{ fontSize: 36, lineHeight: 1, letterSpacing: '-0.02em', margin: '6px 0 8px' }}
          >
            Your <em className="display-it" style={{ color: 'var(--accent)' }}>pockets</em>
          </h1>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5, maxWidth: '38ch' }}>
            Pockets hold photos from an event, briefly. Make one, share the link, watch it fill up.
          </p>

          <div
            style={{
              marginTop: 32,
              padding: 28,
              border: '1px dashed var(--rule)',
              borderRadius: 18,
              background: 'var(--paper-2)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: 12,
            }}
          >
            <PocketEmptyIllo />
            <div className="display" style={{ fontSize: 22, lineHeight: 1.1 }}>
              Your first pocket awaits
            </div>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, maxWidth: '30ch' }}>
              Wedding, dinner, weekend trip — anything where photos are scattered across phones.
            </p>
          </div>

          <Link
            href="/pockets/new"
            className="btn btn-primary btn-block"
            style={{ marginTop: 'auto', minHeight: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none' }}
          >
            <I name="plus" size={18} /> New pocket
          </Link>
        </div>
      ) : (
        <div style={{ padding: '12px 20px 100px' }}>
          <Eyebrow>{activeCount} active</Eyebrow>
          <h1
            className="display"
            style={{ fontSize: 36, lineHeight: 1, letterSpacing: '-0.02em', margin: '6px 0 18px' }}
          >
            Your <em className="display-it" style={{ color: 'var(--accent)' }}>pockets</em>
          </h1>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.map(({ event, role }) => (
              <PocketCard
                key={event.id}
                name={event.name}
                // Schema uses 'host' | 'attendee'; map attendee → 'guest' for display
                role={role === 'host' ? 'host' : 'guest'}
                // Photo count not available without an extra aggregate query.
                // Passing 0 so the card renders "0 photos" rather than adding latency.
                photoCount={0}
                expiresAtMs={event.expiresAt.getTime()}
                href={`/pockets/${event.id}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Floating FAB — populated state only; empty state uses the inline block button above */}
      {activeCount > 0 && (
        <Link
          href="/pockets/new"
          className="btn btn-primary"
          style={{
            position: 'fixed',
            right: 20,
            bottom: 24,
            boxShadow: 'var(--sh-3)',
            borderRadius: 99,
            minHeight: 56,
            padding: '0 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textDecoration: 'none',
          }}
        >
          <I name="plus" size={18} /> New pocket
        </Link>
      )}
    </div>
  )
}
