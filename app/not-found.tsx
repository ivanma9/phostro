import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'

export default function NotFound() {
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
          404
        </div>

        <h1
          className="display"
          style={{
            fontSize: 32,
            lineHeight: 1.05,
            margin: '8px 0 12px',
          }}
        >
          This link doesn&apos;t go{' '}
          <em className="display-it" style={{ color: 'var(--t-alarm)' }}>
            anywhere
          </em>
          .
        </h1>

        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            lineHeight: 1.6,
            maxWidth: '34ch',
          }}
        >
          Double-check it for typos — pocket links look like pocket.app/p/…
        </p>
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 40 }}>
        <Link href="/" className="btn btn-primary btn-block" style={{ minHeight: 52 }}>
          Back home
        </Link>
      </div>
    </main>
  )
}
