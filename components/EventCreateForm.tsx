'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'

export function EventCreateForm() {
  const [name, setName] = useState('')
  const [lifespan, setLifespan] = useState(7)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, lifespanDays: lifespan }),
      })
      if (!res.ok) {
        setError('Could not create event.')
        return
      }
      const { event } = await res.json()
      router.push(`/events/${event.id}`)
    } catch {
      setError('Network error. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Event name"
        required
        maxLength={100}
        className="w-full rounded border px-3 py-2"
      />
      <select
        value={lifespan}
        onChange={(e) => setLifespan(Number(e.target.value))}
        className="w-full rounded border px-3 py-2"
      >
        <option value={3}>3 days</option>
        <option value={7}>7 days</option>
        <option value={14}>14 days</option>
        <option value={30}>30 days</option>
      </select>
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {submitting ? 'Creating…' : 'Create event'}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  )
}
