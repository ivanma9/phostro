'use client'

import { useState } from 'react'

export function MintShareLink({ pocketId }: { pocketId: string }) {
  const [label, setLabel] = useState('Get share link')
  const [busy, setBusy] = useState(false)

  async function mint() {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/pockets/${pocketId}/share-links`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mint link')
      const { shareUrl } = (await res.json()) as { shareUrl: string }
      await navigator.clipboard.writeText(shareUrl)
      setLabel('Copied!')
      setTimeout(() => setLabel('Get share link'), 2000)
    } catch {
      setLabel('Error — try again')
      setTimeout(() => setLabel('Get share link'), 2000)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={mint}
      disabled={busy}
      className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-60"
    >
      {label}
    </button>
  )
}
