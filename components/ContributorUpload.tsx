'use client'

import { useRef, useState } from 'react'
import { uploadBatch } from '@/lib/photos/upload-client'

type Failure = { name: string; reason: string }

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; done: number; total: number; failed: number }
  | { kind: 'done'; added: number; failures: Failure[]; eventName: string }

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
    const failures: Failure[] = []
    results.forEach((r, idx) => {
      if (!r.ok) failures.push({ name: accepted[idx]?.name ?? `photo ${idx + 1}`, reason: r.reason })
    })
    setPhase({ kind: 'done', added, failures, eventName })
  }

  if (phase.kind === 'done') {
    return (
      <div className="space-y-3 text-center">
        <p className="text-lg font-medium">
          Added {phase.added} {phase.added === 1 ? 'photo' : 'photos'} to {phase.eventName}.
        </p>
        {phase.failures.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-left text-sm">
            <p className="font-medium text-red-800">
              {phase.failures.length} {phase.failures.length === 1 ? 'photo' : 'photos'} failed:
            </p>
            <ul className="mt-1 list-disc pl-5 text-red-700">
              {phase.failures.map((f) => (
                <li key={f.name}>
                  <span className="font-mono text-xs">{f.name}</span> — {f.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-sm text-gray-500">You can close this tab.</p>
      </div>
    )
  }

  if (phase.kind === 'uploading') {
    const pct = phase.total === 0 ? 0 : Math.round((phase.done / phase.total) * 100)
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-700">
          Uploading {phase.done} of {phase.total}…
        </p>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full bg-black transition-all duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        {phase.failed > 0 && (
          <p className="text-sm text-red-600">
            {phase.failed} failed so far — details when finished.
          </p>
        )}
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
