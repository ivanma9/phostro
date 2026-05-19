'use client'

import { useRef, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { UploadRow } from '@/components/ui/UploadRow'
import { uploadBatch } from '@/lib/photos/upload-client'

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; done: number; total: number; failed: number; files: File[] }

export function ContributorUpload({
  token,
  hostFirstName = 'them',
  onDone,
}: {
  token: string
  hostFirstName?: string
  /** Called when the upload finishes so the parent can unmount the dropzone card. */
  onDone?: (added: number) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const captureRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  async function handleFiles(files: File[]) {
    const accepted = files.filter((f) => f.type.startsWith('image/'))
    if (accepted.length === 0) return

    setPhase({ kind: 'uploading', done: 0, total: accepted.length, failed: 0, files: accepted })

    const results = await uploadBatch(
      { kind: 'token', token },
      accepted,
      3,
      ({ done, total, failed }) =>
        setPhase((prev) =>
          prev.kind === 'uploading'
            ? { ...prev, done, total, failed }
            : prev,
        ),
    )

    const added = results.filter((r) => r.ok).length
    // Transition back to idle and let parent's onDone swap in its own done UI.
    setPhase({ kind: 'idle' })
    onDone?.(added)
  }

  // ── Uploading state ──────────────────────────────────────────────────────────
  if (phase.kind === 'uploading') {
    // TODO: real per-file progress from uploadBatch — currently synthesized
    // from done/total counts: first `done` files get 100%, next gets 50%, rest 0%
    const rows = phase.files.map((f, i) => {
      const fileSizeMb = (f.size / (1024 * 1024)).toFixed(1) + ' MB'
      if (i < phase.done) return { name: f.name, size: fileSizeMb, pct: 100, active: false, status: undefined as 'queued' | 'error' | undefined }
      if (i === phase.done) return { name: f.name, size: fileSizeMb, pct: 50, active: true, status: undefined as 'queued' | 'error' | undefined }
      return { name: f.name, size: fileSizeMb, pct: 0, active: false, status: 'queued' as const }
    })

    return (
      <div style={{ width: '100%' }}>
        {/* Ink-on-paper progress strip */}
        <div
          style={{
            padding: '14px 16px',
            background: 'var(--ink)',
            color: 'var(--paper)',
            borderRadius: 14,
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 99,
              background: 'rgba(255,248,238,.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 99,
                border: '2px solid rgba(255,248,238,.3)',
                borderTopColor: '#FFF8EE',
                display: 'block',
                animation: 'spin .8s linear infinite',
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              Uploading{' '}
              <span className="num">
                {phase.done} of {phase.total}
              </span>
            </div>
            <div style={{ fontSize: 11.5, opacity: 0.7 }}>
              ~30 seconds left · stay on this page
            </div>
          </div>
          {/* TODO: implement pause functionality */}
          <button
            type="button"
            style={{
              background: 'rgba(255,248,238,.12)',
              border: 0,
              color: 'inherit',
              padding: '6px 12px',
              borderRadius: 99,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Pause
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <UploadRow
              key={r.name}
              name={r.name}
              size={r.size}
              pct={r.pct}
              active={r.active}
              status={r.status}
            />
          ))}
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    )
  }

  // ── Idle state ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* Library picker */}
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
      {/* Camera capture — iOS-native hint via capture="environment" */}
      <input
        ref={captureRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) handleFiles(files)
        }}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => inputRef.current?.click()}
        >
          <Icon name="upload" size={16} /> From library
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => captureRef.current?.click()}
        >
          <Icon name="camera" size={16} /> Take photo
        </button>
      </div>
    </>
  )
}
