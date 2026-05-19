'use client'

import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
import { Eyebrow } from '@/components/ui/Eyebrow'

interface ErrorPageProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function ErrorPage({ reset }: ErrorPageProps) {
  return (
    <main
      style={{
        minHeight: '100dvh',
        background: 'var(--paper)',
        display: 'flex',
        flexDirection: 'column',
        padding: '40px 28px',
        maxWidth: 420,
        margin: '0 auto',
      }}
    >
      <Logo size={22} />

      <div style={{ marginTop: 'auto' }}>
        <div
          className="num"
          style={{
            fontSize: 110,
            lineHeight: 1,
            color: 'var(--paper-3)',
            fontWeight: 300,
          }}
        >
          500
        </div>

        <Eyebrow>Server snag</Eyebrow>

        <h1
          className="display"
          style={{
            fontSize: 32,
            lineHeight: 1.05,
            margin: '8px 0 12px',
          }}
        >
          We hit a{' '}
          <em className="display-it" style={{ color: 'var(--t-alarm)' }}>
            snag
          </em>
          .
        </h1>

        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            lineHeight: 1.6,
            maxWidth: '38ch',
          }}
        >
          Not your fault. We logged it. Try once more — if it keeps happening, write us at{' '}
          <a href="mailto:help@pocket.app" style={{ color: 'inherit' }}>
            help@pocket.app
          </a>
          .
        </p>
      </div>

      <div
        style={{
          marginTop: 'auto',
          paddingTop: 40,
          display: 'flex',
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={reset}
          className="btn btn-primary"
          style={{ flex: 1, minHeight: 52 }}
        >
          Try again
        </button>
        <Link
          href="/"
          className="btn btn-ghost"
          style={{
            flex: 1,
            minHeight: 52,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          Back home
        </Link>
      </div>
    </main>
  )
}
