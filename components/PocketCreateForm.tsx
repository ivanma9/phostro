'use client'

import { useRouter } from 'next/navigation'
import { type ChangeEvent, type FormEvent, useRef, useState } from 'react'

type Phase =
  | { kind: 'name' }
  | { kind: 'selfie'; name: string }
  | { kind: 'enrolling'; name: string }
  | { kind: 'enrolled'; name: string; quality: number }
  | { kind: 'creating' }
  | { kind: 'created'; pocketId: string; shareUrl: string }
  | { kind: 'error'; message: string }

const RETAKE_MESSAGES: Record<string, string> = {
  multiple_faces: 'Please retake without others in frame.',
  no_face: "We couldn't see your face — try better lighting.",
  too_large: 'Photo is too large (max 25 MB). Please choose a smaller one.',
  invalid_file: "We couldn't read that photo. Please use a JPEG, PNG, or HEIC.",
  invalid_size: 'Please choose a photo file.',
  upload_not_found: "Upload didn't make it through — please try again.",
  worker_unavailable:
    'Our face check service is briefly unavailable. Please try again in a moment.',
  unauthenticated: 'Your session expired — please sign in again.',
}

export function PocketCreateForm() {
  const [phase, setPhase] = useState<Phase>({ kind: 'name' })
  const [nameInput, setNameInput] = useState('')
  const [copied, setCopied] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  // Step 1: name → selfie
  function handleNameSubmit(e: FormEvent) {
    e.preventDefault()
    const name = nameInput.trim()
    if (!name || name.length > 100) return
    setPhase({ kind: 'selfie', name })
  }

  // Step 2: selfie file selected → enroll
  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || phase.kind !== 'selfie') return
    const { name } = phase
    setPhase({ kind: 'enrolling', name })

    try {
      // Step A: ask server for a presigned R2 PUT URL.
      // Bypasses Vercel's 4.5 MB request body cap — full-res phone selfies are routinely
      // larger than that, and a multipart POST through the function fails as 413 / network error.
      const initRes = await fetch('/api/me/face/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mimeType: file.type, sizeBytes: file.size }),
      })
      if (!initRes.ok) {
        const { error } = (await initRes.json().catch(() => ({}))) as { error?: string }
        const message =
          (error && RETAKE_MESSAGES[error]) ?? 'Something went wrong — please try again.'
        if (fileRef.current) fileRef.current.value = ''
        setPhase({ kind: 'error', message })
        return
      }
      const { key, putUrl } = (await initRes.json()) as { key: string; putUrl: string }

      // Step B: PUT the file straight to R2.
      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      })
      if (!putRes.ok) {
        if (fileRef.current) fileRef.current.value = ''
        setPhase({ kind: 'error', message: 'Upload failed — please try again.' })
        return
      }

      // Step C: tell the server to process the uploaded key.
      const finRes = await fetch('/api/me/face/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      if (finRes.ok) {
        const { quality } = (await finRes.json()) as { quality: number }
        setPhase({ kind: 'enrolled', name, quality })
        return
      }
      const { error } = (await finRes.json().catch(() => ({}))) as { error?: string }
      const message =
        (error && RETAKE_MESSAGES[error]) ?? 'Something went wrong — please try again.'
      if (fileRef.current) fileRef.current.value = ''
      setPhase({ kind: 'error', message })
    } catch {
      if (fileRef.current) fileRef.current.value = ''
      setPhase({ kind: 'error', message: 'Network error — please try again.' })
    }
  }

  // Step 3: confirmed enrollment → create pocket
  async function handleCreatePocket() {
    if (phase.kind !== 'enrolled') return
    const { name } = phase
    setPhase({ kind: 'creating' })

    try {
      const res = await fetch('/api/pockets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
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
      <form onSubmit={handleNameSubmit} className="space-y-3">
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
          Next
        </button>
      </form>
    )
  }

  if (phase.kind === 'selfie' || phase.kind === 'enrolling') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          Take or upload a clear selfie so we can find your face in photos.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="user"
          onChange={handleFileChange}
          disabled={phase.kind === 'enrolling'}
          className="w-full"
        />
        {phase.kind === 'enrolling' && (
          <p className="text-sm text-gray-500">Checking your photo…</p>
        )}
      </div>
    )
  }

  if (phase.kind === 'enrolled') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-green-700">Looks great! Quality: {phase.quality}%</p>
        <button
          type="button"
          onClick={handleCreatePocket}
          className="w-full rounded bg-black px-4 py-2 text-white"
        >
          Create pocket
        </button>
      </div>
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
