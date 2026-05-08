'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'

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
  const [copied, setCopied] = useState(false)
  const router = useRouter()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
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

  if (phase.kind === 'name') {
    return (
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          placeholder="Pocket name"
          required
          maxLength={100}
          className="w-full rounded border px-3 py-2"
        />
        <button
          type="submit"
          className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          Create pocket
        </button>
      </form>
    )
  }

  if (phase.kind === 'creating') {
    return <p className="text-sm text-gray-500">Creating your pocket…</p>
  }

  if (phase.kind === 'created') {
    async function handleCopy() {
      if (phase.kind !== 'created') return
      await navigator.clipboard.writeText(phase.shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }

    return (
      <div className="space-y-3">
        <p className="text-sm font-medium text-green-700">Your pocket is ready! Share this link:</p>
        <input
          readOnly
          value={phase.shareUrl}
          className="w-full rounded border bg-gray-50 px-3 py-2 text-sm font-mono"
          onFocus={(e) => e.target.select()}
        />
        <button
          type="button"
          onClick={handleCopy}
          className="w-full rounded bg-black px-4 py-2 text-white"
        >
          {copied ? 'Copied!' : 'Copy share link'}
        </button>
        <button
          type="button"
          onClick={() => router.push(`/pockets/${phase.pocketId}`)}
          className="w-full rounded border px-4 py-2 text-sm"
        >
          Open pocket
        </button>
      </div>
    )
  }

  // error phase
  return (
    <div className="space-y-3">
      <p className="text-sm text-red-600">{phase.message}</p>
      <button
        type="button"
        onClick={() => setPhase({ kind: 'name' })}
        className="w-full rounded border px-4 py-2"
      >
        Start over
      </button>
    </div>
  )
}
