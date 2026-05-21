import { Logo } from '@/components/ui/Logo'
import { Eyebrow } from '@/components/ui/Eyebrow'

export const metadata = {
  title: 'Terms of Service — Pocket',
}

export default function TermsOfServicePage() {
  return (
    <main
      style={{
        background: 'var(--paper)',
        minHeight: '100dvh',
        padding: '40px 28px 64px',
        maxWidth: 640,
        margin: '0 auto',
      }}
    >
      <Logo size={22} />

      <div style={{ marginTop: 28 }}>
        <Eyebrow>Terms of Service</Eyebrow>
        <h1
          className="display"
          style={{
            fontSize: 36,
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
            margin: '6px 0 8px',
          }}
        >
          Terms of{' '}
          <em className="display-it" style={{ color: 'var(--accent)' }}>
            Service
          </em>
        </h1>
        <p
          style={{
            fontSize: 13,
            color: 'var(--muted)',
            lineHeight: 1.55,
            margin: 0,
          }}
        >
          Lawyer-approved. Plain English first.
        </p>
      </div>

      <div className="rule" style={{ margin: '28px 0' }} />

      {/* Section 1 */}
      <section>
        <h2
          className="display"
          style={{ fontSize: 19, lineHeight: 1.2, margin: '0 0 6px' }}
        >
          1 — Photos belong to whoever took them
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-soft)',
            lineHeight: 1.65,
            margin: 0,
          }}
        >
          When you upload a photo, you keep the copyright. We just hold it briefly and show it to
          the host of the pocket. We never claim to own anything.
        </p>
      </section>

      <div className="rule" style={{ margin: '20px 0' }} />

      {/* Section 2 */}
      <section>
        <h2
          className="display"
          style={{ fontSize: 19, lineHeight: 1.2, margin: '0 0 6px' }}
        >
          2 — Pockets auto-delete
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-soft)',
            lineHeight: 1.65,
            margin: 0,
          }}
        >
          By uploading a photo through a share link, you confirm you have permission to share that
          photo with the person who sent you the link.
        </p>
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-soft)',
            lineHeight: 1.65,
            margin: '10px 0 0',
          }}
        >
          Every pocket lasts 30 days. At the deadline, we hard-delete the photos and the metadata.
          The host gets one ZIP download before that happens.
        </p>
      </section>

      <div className="rule" style={{ margin: '20px 0' }} />

      {/* Section 3 */}
      <section>
        <h2
          className="display"
          style={{ fontSize: 19, lineHeight: 1.2, margin: '0 0 6px' }}
        >
          3 — No training, no resale
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-soft)',
            lineHeight: 1.65,
            margin: 0,
          }}
        >
          Photos you upload are visible only to the share link&apos;s owner. We use face matching
          to filter the owner&apos;s feed; we do not link faces back to identity for any other
          person.
        </p>
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-soft)',
            lineHeight: 1.65,
            margin: '10px 0 0',
          }}
        >
          We don&apos;t use your photos to train AI models. We don&apos;t sell them. We don&apos;t
          scan them for content beyond what&apos;s needed to keep the service alive (e.g. malware
          checks on upload).
        </p>
      </section>

      <div className="rule" style={{ margin: '20px 0' }} />

      {/* Section 4 */}
      <section>
        <h2
          className="display"
          style={{ fontSize: 19, lineHeight: 1.2, margin: '0 0 6px' }}
        >
          4 — Attribution is on by default
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-soft)',
            lineHeight: 1.65,
            margin: 0,
          }}
        >
          Photos show who uploaded them — first name or handle. Guests can stay anonymous in the
          upload step.
        </p>
      </section>

      <div className="rule" style={{ margin: '20px 0' }} />

      {/* Section 5 */}
      <section>
        <h2
          className="display"
          style={{ fontSize: 19, lineHeight: 1.2, margin: '0 0 6px' }}
        >
          5 — Be kind
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-soft)',
            lineHeight: 1.65,
            margin: 0,
          }}
        >
          No CSAM, no harassment, no copyright-infringing material you don&apos;t have rights to.
          Hosts can revoke shares; we can revoke pockets.
        </p>
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-soft)',
            lineHeight: 1.65,
            margin: '10px 0 0',
          }}
        >
          This is a closed beta. For questions, reply to whoever sent you the link or write us at{' '}
          <a href="mailto:help@pocket.app" style={{ color: 'var(--ink)' }}>
            help@pocket.app
          </a>
          .
        </p>
      </section>

      <p
        style={{
          marginTop: 32,
          fontSize: 11.5,
          color: 'var(--muted)',
          lineHeight: 1.55,
          fontStyle: 'italic',
        }}
      >
        Long-form legal text available on request. Questions? help@pocket.app.
      </p>
    </main>
  )
}
