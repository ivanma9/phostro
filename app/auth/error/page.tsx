import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'

type Kind = 'expired' | 'invalid' | 'generic'

const VARIANTS: Record<Kind, { eyebrow: string; titleBefore: string; titleEm: string; titleAfter: string; body: string; cta: string }> = {
  expired: {
    eyebrow: 'Magic link expired',
    titleBefore: 'That link is no longer ',
    titleEm: 'live',
    titleAfter: '.',
    body: 'Magic links last 15 minutes. Ask us for a fresh one and you’re back in.',
    cta: 'Send a new link',
  },
  invalid: {
    eyebrow: 'Invalid token',
    titleBefore: 'Hmm, that ',
    titleEm: 'doesn’t match',
    titleAfter: '.',
    body: 'The link may have been copied incomplete, or used already. Sign in again to continue.',
    cta: 'Back to sign in',
  },
  generic: {
    eyebrow: 'Sign-in failed',
    titleBefore: 'We hit a ',
    titleEm: 'snag',
    titleAfter: '.',
    body: 'Not your fault. We logged it. Try once more — if it keeps happening, write us at help@pocket.app.',
    cta: 'Try again',
  },
}

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>
}) {
  const { kind } = await searchParams
  const variant = VARIANTS[(kind as Kind) in VARIANTS ? (kind as Kind) : 'generic']

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 16px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          padding: '40px 28px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Logo size={26} />

        <div style={{ marginTop: 56 }}>
          <div className="eyebrow" style={{ color: 'var(--t-alarm)' }}>{variant.eyebrow}</div>
          <h1
            className="display"
            style={{ fontSize: 40, lineHeight: 1.0, margin: '8px 0 14px' }}
          >
            {variant.titleBefore}
            <em className="display-it" style={{ color: 'var(--t-alarm)' }}>{variant.titleEm}</em>
            {variant.titleAfter}
          </h1>
          <p style={{ fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.55, maxWidth: '34ch' }}>
            {variant.body}
          </p>
        </div>

        <Link
          href="/auth/signin"
          className="btn btn-primary btn-block"
          style={{ minHeight: 52, marginTop: 32, textAlign: 'center' }}
        >
          {variant.cta}
        </Link>
      </div>
    </main>
  )
}
