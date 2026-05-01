'use client'

import { type ChangeEvent, type DragEvent, useRef, useState } from 'react'
import { uploadBatch } from '@/lib/photos/upload-client'

const ACCEPTED = 'image/jpeg,image/png,image/heic,image/heif'

export function UploadDropzone({ eventId }: { eventId: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(
    null,
  )
  const [dragOver, setDragOver] = useState(false)

  async function handleFiles(files: File[]) {
    const accepted = files.filter((f) =>
      ['image/jpeg', 'image/png', 'image/heic', 'image/heif'].includes(f.type),
    )
    if (accepted.length === 0) return
    setProgress({ done: 0, total: accepted.length, failed: 0 })
    await uploadBatch(eventId, accepted, 3, setProgress)
    // After all done, refresh the gallery by hard-reloading. Phase 5 will replace
    // this with optimistic UI / incremental rendering.
    window.location.reload()
  }

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) handleFiles(files)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) handleFiles(files)
  }

  return (
    <section
      aria-label="Photo upload dropzone"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`rounded border-2 border-dashed p-6 text-center ${
        dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        multiple
        className="hidden"
        onChange={onChange}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="rounded bg-black px-4 py-2 text-white"
      >
        Add photos
      </button>
      <p className="mt-2 text-sm text-gray-500">or drag and drop here</p>
      {progress && progress.done < progress.total && (
        <p className="mt-3 text-sm">
          Uploading {progress.done} of {progress.total}…
        </p>
      )}
      {progress && progress.done === progress.total && (
        <p className="mt-3 text-sm">
          Uploaded {progress.done - progress.failed} of {progress.total}.
          {progress.failed > 0 && ` ${progress.failed} failed.`}
        </p>
      )}
    </section>
  )
}
