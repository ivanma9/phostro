import Link from 'next/link'
import { redirect } from 'next/navigation'
import { FaceScanEnroll } from '@/components/FaceScanEnroll'
import { getCurrentUser } from '@/lib/auth/current-user'
import { Logo } from '@/components/ui/Logo'
import { Eyebrow } from '@/components/ui/Eyebrow'
import { Icon } from '@/components/ui/Icon'

export default async function FaceEnrollPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/signin?next=/me/face/enroll')

  return (
    <main
      style={{
        background: 'var(--paper)',
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        maxWidth: 420,
        margin: '0 auto',
      }}
    >
      {/* App bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '14px 20px 10px',
          borderBottom: '1px solid var(--rule-soft)',
        }}
      >
        <Link
          href="/"
          aria-label="Back to home"
          style={{
            display: 'flex',
            alignItems: 'center',
            color: 'var(--ink)',
            marginRight: 4,
          }}
        >
          <Icon name="back" size={20} />
        </Link>
        <Logo size={18} />
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 13,
            color: 'var(--muted)',
            fontWeight: 500,
          }}
        >
          Set up face matching
        </span>
      </div>

      {/* Intro */}
      <div style={{ padding: '20px 20px 0' }}>
        <Eyebrow>Privacy you control</Eyebrow>
        <h1
          className="display"
          style={{
            fontSize: 30,
            lineHeight: 1.08,
            margin: '6px 0 10px',
          }}
        >
          Match yourself in your{' '}
          <em className="display-it" style={{ color: 'var(--accent)' }}>
            photos
          </em>
          .
        </h1>
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-soft)',
            lineHeight: 1.6,
            margin: '0 0 20px',
          }}
        >
          Three quick captures — frontal, left, right — so we can surface your photos first in the
          pocket. Your face data never leaves your account.
        </p>
      </div>

      {/* Component */}
      <div style={{ padding: '0 20px 32px', flex: 1 }}>
        <FaceScanEnroll />
      </div>
    </main>
  )
}
