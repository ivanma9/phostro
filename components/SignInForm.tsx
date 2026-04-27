'use client'

import { type FormEvent, useState } from 'react'

export function SignInForm() {
  const [contact, setContact] = useState('')
  const [name, setName] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contact, name }),
      })
      if (res.ok) setSent(true)
      else setError('Could not send magic link.')
    } catch {
      setError('Network error. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (sent) {
    return (
      <p className="text-sm">
        Check <strong>{contact}</strong> for your sign-in link.
      </p>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name"
        required
        className="w-full rounded border px-3 py-2"
      />
      <input
        value={contact}
        onChange={(e) => setContact(e.target.value)}
        placeholder="email@example.com"
        type="email"
        required
        className="w-full rounded border px-3 py-2"
      />
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {submitting ? 'Sending…' : 'Send magic link'}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  )
}
