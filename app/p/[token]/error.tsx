'use client'

import { Icon } from '@/components/ui/Icon'
import type { IconName } from '@/components/ui/Icon'
import { Logo } from '@/components/ui/Logo'

type DeadEndKind = 'exhausted' | 'revoked' | 'expired' | 'invalid'

const DEAD_END_MAP: Record<
  DeadEndKind,
  {
    icon: IconName
    eyebrow: string
    title: React.ReactNode
    body: string
    ctaLabel?: string
  }
> = {
  exhausted: {
    icon: 'lock',
    eyebrow: 'Limit reached',
    title: (
      <>
        This share link is{' '}
        <em className="display-it" style={{ color: 'var(--accent)' }}>
          full
        </em>
        .
      </>
    ),
    body: "The host set a limit on uploads, and we've hit it. Ask them for a fresh link if you have more photos.",
  },
  revoked: {
    icon: 'lock',
    eyebrow: 'Link revoked',
    title: (
      <>
        This link was{' '}
        <em className="display-it" style={{ color: 'var(--t-alarm)' }}>
          turned off
        </em>
        .
      </>
    ),
    body: "Not your fault — this link was closed. If you were planning to upload, message the host and they'll send a new one.",
  },
  expired: {
    icon: 'clock',
    eyebrow: 'Pocket expired',
    title: (
      <>
        This pocket has already{' '}
        <em className="display-it" style={{ color: 'var(--muted)' }}>
          closed
        </em>
        .
      </>
    ),
    body: 'Pockets auto-delete after their lifespan ends. The host can choose to download what was collected.',
  },
  invalid: {
    icon: 'warn',
    eyebrow: '404',
    title: (
      <>
        This link doesn&rsquo;t go{' '}
        <em className="display-it" style={{ color: 'var(--t-alarm)' }}>
          anywhere
        </em>
        .
      </>
    ),
    body: "Double-check it for typos — pocket links look like pocket.app/p/…",
    ctaLabel: 'Try again',
  },
}

function deriveKind(error: Error & { digest?: string; code?: string }): DeadEndKind {
  // ShareLinkError attaches a `code` property
  const code = (error as { code?: string }).code
  if (code === 'revoked') return 'revoked'
  if (code === 'expired') return 'expired'
  if (code === 'exhausted') return 'exhausted'
  if (code === 'invalid') return 'invalid'

  // Fallback: try to read from digest or message
  const msg = error.message?.toLowerCase() ?? ''
  if (msg.includes('revoked')) return 'revoked'
  if (msg.includes('expired')) return 'expired'
  if (msg.includes('exhausted')) return 'exhausted'

  return 'invalid'
}

export default function ContributorError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const kind = deriveKind(error)
  const map = DEAD_END_MAP[kind]

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

      <div
        style={{
          padding: '40px 28px',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          flex: 1,
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
          <Icon name={map.icon} size={26} stroke={1.6} />
        </div>
        <div className="eyebrow">{map.eyebrow}</div>
        <h2
          className="display"
          style={{ fontSize: 30, lineHeight: 1.05, margin: 0 }}
        >
          {map.title}
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            lineHeight: 1.55,
            maxWidth: '34ch',
          }}
        >
          {map.body}
        </p>
        {map.ctaLabel && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={reset}
            style={{ marginTop: 8 }}
          >
            {map.ctaLabel}
          </button>
        )}
      </div>

      <div
        style={{
          padding: '16px 28px',
          textAlign: 'center',
          fontSize: 11.5,
          color: 'var(--muted)',
        }}
      >
        <Logo size={16} /> ·{' '}
        <a href="https://pocket.app" style={{ textDecoration: 'underline' }}>
          pocket.app
        </a>
      </div>
    </main>
  )
}
