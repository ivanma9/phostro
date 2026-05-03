'use client'

import { useRef, useState } from 'react'
import { uploadBatch } from '@/lib/photos/upload-client'

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; done: number; total: number; failed: number }
  | { kind: 'done'; added: number; eventName: string }

export function ContributorUpload({ token, eventName }: { token: string; eventName: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  async function handleFiles(files: File[]) {
    const accepted = files.filter((f) => f.type.startsWith('image/'))
    if (accepted.length === 0) return

    setPhase({ kind: 'uploading', done: 0, total: accepted.length, failed: 0 })

    const results = await uploadBatch(
      { kind: 'token', token },
      accepted,
      3,
      ({ done, total, failed }) => setPhase({ kind: 'uploading', done, total, failed }),
    )

    const added = results.filter((r) => r.ok).length
    setPhase({ kind: 'done', added, eventName })
  }

  if (phase.kind === 'done') {
    return (
      <div className="text-center">
        <p className="text-lg font-medium">
          Added {phase.added} {phase.added === 1 ? 'photo' : 'photos'} to {phase.eventName}.
        </p>
        <p className="mt-1 text-sm text-gray-500">You can close this tab.</p>
      </div>
    )
  }

  if (phase.kind === 'uploading') {
    return (
      <div className="text-center">
        <p className="text-sm text-gray-700">
          Uploading {phase.done} of {phase.total}…
        </p>
        {phase.failed > 0 && <p className="mt-1 text-sm text-red-600">{phase.failed} failed.</p>}
      </div>
    )
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) handleFiles(files)
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full rounded-xl bg-black py-4 text-lg font-semibold text-white active:opacity-80"
      >
        Add Photos
      </button>
    </>
  )
}
