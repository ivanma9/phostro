import { Logo } from '@/components/ui/Logo'

export default function ContributorLoading() {
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
      {/* Logo header — mirrors GuestShell */}
      <div style={{ padding: '14px 20px 8px' }}>
        <Logo size={18} />
      </div>

      {/* Skeleton mirrors GuestHero layout */}
      <div style={{ padding: '6px 20px 8px' }}>
        {/* Eyebrow skeleton */}
        <div
          className="skel"
          style={{ height: 12, width: 140, borderRadius: 6, marginBottom: 14 }}
        />
        {/* Headline skeleton — 2 lines */}
        <div
          className="skel"
          style={{ height: 36, width: '92%', borderRadius: 6, marginBottom: 8 }}
        />
        <div
          className="skel"
          style={{ height: 36, width: '68%', borderRadius: 6, marginBottom: 12 }}
        />
        {/* Body skeleton */}
        <div
          className="skel"
          style={{ height: 13, width: '88%', borderRadius: 6, marginBottom: 6 }}
        />
        <div
          className="skel"
          style={{ height: 13, width: '74%', borderRadius: 6 }}
        />
      </div>

      {/* Dropzone skeleton */}
      <div style={{ padding: '8px 20px 0' }}>
        <div
          className="skel"
          style={{ height: 220, borderRadius: 18 }}
        />
      </div>

      {/* Button skeleton */}
      <div style={{ padding: '20px 20px 0', display: 'flex', gap: 8, justifyContent: 'center' }}>
        <div className="skel" style={{ height: 44, width: 130, borderRadius: 99 }} />
        <div className="skel" style={{ height: 44, width: 120, borderRadius: 99 }} />
      </div>
    </main>
  )
}
