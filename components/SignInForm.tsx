'use client'

import { useSearchParams } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { I } from '@/components/ui/Icon'

type State = 'idle' | 'submitting' | 'sent' | 'error'

export function SignInForm() {
  const params = useSearchParams()
  const next = params.get('next')
  const [contact, setContact] = useState('')
  const [name, setName] = useState('')
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErrorMsg(null)
    setState('submitting')
    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact, name, next }),
      })
      if (res.ok) {
        setState('sent')
      } else {
        setErrorMsg('Could not send magic link.')
        setState('error')
      }
    } catch {
      setErrorMsg('Network error. Try again.')
      setState('error')
    }
  }

  function reset() {
    setState('idle')
    setErrorMsg(null)
  }

  /* --- sent / check-email --- */
  if (state === 'sent') {
    return (
      <div style={{ marginTop: 88, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 76, height: 76, borderRadius: 99, background: 'var(--paper-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--rule)' }}>
          <I name="mail" size={32} stroke={1.4} />
        </div>
        <div className="eyebrow">Check your inbox</div>
        <h2 className="display" style={{ fontSize: 32, lineHeight: 1.1, margin: 0, letterSpacing: '-0.02em' }}>
          We sent you a <em className="display-it" style={{ color: 'var(--accent)' }}>magic link</em>
        </h2>
        <p style={{ fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.55, maxWidth: '32ch' }}>
          Tap the link in <span style={{ color: 'var(--ink-soft)' }}>{contact}</span> to sign in. It expires in 15 minutes.
        </p>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
          <a href="mailto:" className="btn btn-ghost btn-block" style={{ textAlign: 'center' }}>Open mail app</a>
          <button
            type="button"
            onClick={reset}
            style={{ background: 'none', border: 0, color: 'var(--muted)', fontSize: 12.5, padding: 8, cursor: 'pointer' }}
          >
            Wrong email? <span style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Go back</span>
          </button>
        </div>
      </div>
    )
  }

  /* --- error --- */
  if (state === 'error') {
    return (
      <form onSubmit={submit}>
        <div style={{ marginTop: 56 }}>
          <div className="eyebrow" style={{ color: 'var(--t-alarm)' }}>Something went wrong</div>
          <h1 className="display" style={{ fontSize: 40, lineHeight: 1.0, margin: '8px 0 14px' }}>
            Couldn&apos;t send the <em className="display-it" style={{ color: 'var(--t-alarm)' }}>link</em>.
          </h1>
          <p style={{ fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.55 }}>
            Check the address and try again — sometimes our mail provider sneezes.
          </p>
        </div>
        <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* name input intentionally hidden in error state per design (screens-auth.jsx:107)
              — value is preserved in state and included in the retry POST */}
          <label style={{ display: 'block' }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Your email</div>
            <input
              className="input"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="you@hello.com"
              type="email"
              required
              aria-invalid="true"
              style={{ borderColor: 'var(--err)' }}
            />
          </label>
          <button className="btn btn-primary btn-block" type="submit" style={{ minHeight: 52 }}>
            Try again
          </button>
        </div>
        {errorMsg && (
          <p style={{ fontSize: 12, color: 'var(--t-alarm)', marginTop: 8 }}>{errorMsg}</p>
        )}
      </form>
    )
  }

  /* --- idle + submitting --- */
  const isSubmitting = state === 'submitting'

  return (
    <form onSubmit={submit}>
      <div style={{ marginTop: 56 }}>
        {isSubmitting ? (
          <>
            <div className="eyebrow">Sending</div>
            <h1 className="display" style={{ fontSize: 44, lineHeight: 1.0, margin: '8px 0 14px' }}>
              One <em className="display-it" style={{ color: 'var(--accent)' }}>moment</em>&hellip;
            </h1>
          </>
        ) : (
          <>
            <div className="eyebrow">For hosts</div>
            <h1 className="display" style={{ fontSize: 44, lineHeight: 1.0, letterSpacing: '-0.02em', margin: '8px 0 14px' }}>
              A pocket for<br />your <em className="display-it" style={{ color: 'var(--accent)' }}>event</em>.
            </h1>
            <p style={{ fontSize: 14.5, color: 'var(--muted)', lineHeight: 1.55, maxWidth: '30ch' }}>
              Guests upload photos with one link. You download them all. Then it disappears.
            </p>
          </>
        )}
      </div>

      <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {isSubmitting ? (
          <div
            className="input"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--ink-soft)' }}
          >
            {contact || 'you@hello.com'}
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 99,
                border: '2px solid var(--rule)',
                borderTopColor: 'var(--accent)',
                animation: 'spin 0.8s linear infinite',
                flexShrink: 0,
              }}
            />
          </div>
        ) : (
          <>
            <label style={{ display: 'block' }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Your name</div>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                required
                maxLength={100}
                disabled={isSubmitting}
              />
            </label>
            <label style={{ display: 'block' }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>Your email</div>
              <input
                className="input"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="you@hello.com"
                type="email"
                required
                disabled={isSubmitting}
              />
            </label>
          </>
        )}

        <button
          className="btn btn-primary btn-block"
          type="submit"
          disabled={isSubmitting}
          style={{ minHeight: 52, ...(isSubmitting ? { opacity: 0.5 } : {}) }}
        >
          {isSubmitting ? (
            'Sending magic link'
          ) : (
            <><I name="mail" size={16} /> Send me a magic link</>
          )}
        </button>

        {!isSubmitting && (
          <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.5 }}>
            We&apos;ll email a one-tap sign-in. No passwords, ever.
          </p>
        )}
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </form>
  )
}
