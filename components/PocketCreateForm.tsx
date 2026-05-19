'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { I } from '@/components/ui/Icon'
import { Eyebrow } from '@/components/ui/Eyebrow'
import { Toggle } from '@/components/ui/Toggle'
import { ShareBlock } from '@/components/ui/ShareBlock'

// Pocket creation post-face-scan-v1: enrollment is a separate route. The page
// hosting this form (app/(app)/pockets/new/page.tsx) gates on
// getFaceEnrollment().enrolled and redirects to /me/face/enroll if missing,
// so this form starts at "name a pocket" — no selfie sub-flow.

type Phase =
  | { kind: 'name' }
  | { kind: 'creating' }
  | { kind: 'created'; pocketId: string; shareUrl: string }
  | { kind: 'error'; message: string }

export function PocketCreateForm() {
  const [phase, setPhase] = useState<Phase>({ kind: 'name' })
  const [nameInput, setNameInput] = useState('')
  const [touched, setTouched] = useState(false)
  const router = useRouter()

  const nameError =
    touched && nameInput.trim().length === 0
      ? 'Give your pocket a name guests will recognize.'
      : touched && nameInput.length > 100
        ? 'Name must be 100 characters or fewer.'
        : null

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    const name = nameInput.trim()
    if (!name || name.length > 100) return
    setPhase({ kind: 'creating' })
    try {
      const res = await fetch('/api/pockets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        if (body.error === 'not_enrolled') {
          // Server lost track between the page-render gate and submit. Send
          // the user through the scan flow.
          router.replace('/me/face/enroll?next=/pockets/new')
          return
        }
        setPhase({ kind: 'error', message: 'Could not create pocket — please try again.' })
        return
      }
      const { pocketId, shareUrl } = (await res.json()) as { pocketId: string; shareUrl: string }
      setPhase({ kind: 'created', pocketId, shareUrl })
    } catch {
      setPhase({ kind: 'error', message: 'Network error — please try again.' })
    }
  }

  const isCreating = phase.kind === 'creating'

  if (phase.kind === 'name' || phase.kind === 'creating') {
    return (
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Eyebrow>Step 1 of 1</Eyebrow>
        <h1
          className="display"
          style={{ fontSize: 32, lineHeight: 1.05, margin: '0 0 4px' }}
        >
          Name your{' '}
          <em className="display-it" style={{ color: 'var(--accent)' }}>
            pocket
          </em>
        </h1>

        <label>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Pocket name
          </div>
          <input
            className="input"
            value={nameInput}
            onChange={(e) => {
              setNameInput(e.target.value)
              if (!touched) setTouched(true)
            }}
            onBlur={() => setTouched(true)}
            placeholder="Mason's 5th birthday"
            maxLength={110} /* let the user see they're over, we block submit */
            disabled={isCreating}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'name-error' : undefined}
          />
          {nameError && (
            <div
              id="name-error"
              style={{
                marginTop: 6,
                fontSize: 12,
                color: 'var(--t-alarm)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <I name="warn" size={12} />
              {nameError}
            </div>
          )}
        </label>

        <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          Your pocket lasts 7 days. We auto-delete every photo at expiry.
        </p>

        {/* Attribution toggle — always-on (mandatory per locked v1 decisions). */}
        {/* TODO: surface attribution opt-out in v2 */}
        <div
          style={{
            padding: 14,
            borderRadius: 12,
            background: 'var(--paper-2)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Show photographer credit</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              Each photo shows who uploaded it.
            </div>
          </div>
          {/* Decorative — attribution is mandatory in v1 */}
          <Toggle
            on={true}
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            onChange={() => { /* attribution always on in v1 */ }}
            aria-label="Show photographer credit (always on)"
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary btn-block"
          style={{ marginTop: 4, minHeight: 52 }}
          disabled={isCreating}
        >
          {isCreating ? (
            'Creating…'
          ) : (
            <>
              Create pocket <I name="arrow" size={16} />
            </>
          )}
        </button>
      </form>
    )
  }

  if (phase.kind === 'created') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <Eyebrow>Pocket created</Eyebrow>
          <h1
            className="display"
            style={{ fontSize: 32, lineHeight: 1.05, margin: '6px 0 0' }}
          >
            Share{' '}
            <em className="display-it" style={{ color: 'var(--accent)' }}>
              your pocket
            </em>
          </h1>
        </div>

        {/* TODO: wire actual remaining count from API response once the endpoint returns it */}
        <ShareBlock url={phase.shareUrl} remaining="50 / 50" />

        <button
          type="button"
          className="btn btn-primary btn-block"
          style={{ minHeight: 52 }}
          onClick={() => router.push(`/pockets/${phase.pocketId}`)}
        >
          Open pocket <I name="arrow" size={16} />
        </button>
      </div>
    )
  }

  // error phase — nameInput is preserved so the user can retry with their text intact
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Eyebrow>Step 1 of 1</Eyebrow>
      <h1
        className="display"
        style={{ fontSize: 32, lineHeight: 1.05, margin: '0 0 4px' }}
      >
        Name your{' '}
        <em className="display-it" style={{ color: 'var(--accent)' }}>
          pocket
        </em>
      </h1>

      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: 'var(--t-alarm-bg)',
          color: 'var(--t-alarm)',
          fontSize: 12.5,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <I name="warn" size={14} />
        {phase.message}
      </div>

      <label>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Pocket name
        </div>
        <input
          className="input"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          placeholder="Mason's 5th birthday"
          maxLength={110}
        />
      </label>

      <button
        type="button"
        className="btn btn-primary btn-block"
        style={{ minHeight: 52 }}
        onClick={() => setPhase({ kind: 'name' })}
      >
        Try again <I name="arrow" size={16} />
      </button>
    </div>
  )
}
