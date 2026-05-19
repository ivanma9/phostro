'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Icon } from '@/components/ui/Icon'

type Angle = 'frontal' | 'left' | 'right'
const ANGLE_ORDER: Angle[] = ['frontal', 'left', 'right']

const PROMPT_BY_ANGLE: Record<Angle, string> = {
  frontal: 'Look straight at the camera',
  left: 'Slowly turn your head to the left',
  right: 'Slowly turn your head to the right',
}
const SHORT_BY_ANGLE: Record<Angle, string> = {
  frontal: 'Frontal',
  left: 'Left',
  right: 'Right',
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; current: Angle; lastError?: string }
  | { kind: 'capturing' }
  | { kind: 'all_done' }

type StatusResponse = {
  enrolled: boolean
  enrolledAngles: Angle[]
  remainingAngles: Angle[]
}

type FinalizeResponse = StatusResponse & {
  angle: Angle
  quality: number
  yaw: number
}

type ErrorResponse = {
  error: string
  angle?: Angle
  yaw?: number
  expected?: Angle
  detected?: number
  topConfidence?: number | null
  distances?: Array<{ angle: Angle; distance: number }>
}

const ALLOWED_MIME = 'image/jpeg'

async function blobFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas_to_blob_failed'))),
      ALLOWED_MIME,
      0.92,
    )
  })
}

function describeError(err: ErrorResponse): string {
  switch (err.error) {
    case 'no_face':
      return 'I could not see a face — move closer and try again.'
    case 'multiple_faces':
      return 'Multiple people in frame — make sure only you are visible.'
    case 'wrong_pose':
      return err.expected === 'frontal'
        ? 'Look straight at the camera and hold still.'
        : err.expected === 'left'
          ? 'Turn your head a little more to the left.'
          : 'Turn your head a little more to the right.'
    case 'too_similar_to_existing':
      return 'This shot looks the same as your last one. Turn your head a bit more.'
    case 'invalid_file':
      return 'That image was not usable. Try again with better lighting.'
    case 'too_large':
      return 'Image too large; try again.'
    case 'worker_unavailable':
      return 'The face service is temporarily unavailable. Try again in a moment.'
    case 'r2_put_failed':
      return 'Photo upload failed — check your connection and try again.'
    default:
      return 'Something went wrong. Try again.'
  }
}

async function captureAndEnroll(angle: Angle, blob: Blob): Promise<FinalizeResponse> {
  const initRes = await fetch('/api/me/face/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mimeType: ALLOWED_MIME, sizeBytes: blob.size }),
  })
  if (!initRes.ok) {
    const body = (await initRes.json().catch(() => ({}))) as ErrorResponse
    throw body
  }
  const { key, putUrl } = (await initRes.json()) as { key: string; putUrl: string }

  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': ALLOWED_MIME },
    body: blob,
  })
  if (!putRes.ok) {
    throw { error: 'r2_put_failed' } as ErrorResponse
  }

  const finRes = await fetch('/api/me/face/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, angle }),
  })
  const data = (await finRes.json().catch(() => ({}))) as FinalizeResponse | ErrorResponse
  if (!finRes.ok) {
    throw data as ErrorResponse
  }
  return data as FinalizeResponse
}

export function FaceScanEnroll() {
  const router = useRouter()
  const search = useSearchParams()
  // Open-redirect guard: only honor relative paths (`/<rest>`), refuse anything
  // that could be an external URL or a protocol-relative `//host`. A malicious
  // `?next=https://evil.com/...` link would otherwise bounce a logged-in user.
  const rawNext = search?.get('next') || ''
  const nextHref =
    rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/'

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [enrolledAngles, setEnrolledAngles] = useState<Angle[]>([])
  const [cameraDenied, setCameraDenied] = useState(false)

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  // Initial status fetch + camera permission
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/me/face/status')
        if (!res.ok) {
          // Surface the file-input fallback so the user has a working path even
          // when status fetch fails (network blip, auth expiry); the camera
          // setup below is also skipped on this branch.
          if (!cancelled) {
            setCameraDenied(true)
            setPhase({
              kind: 'ready',
              current: 'frontal',
              lastError: 'Could not load enrollment progress — try uploading a photo instead.',
            })
          }
          return
        }
        const status = (await res.json()) as StatusResponse
        if (cancelled) return
        setEnrolledAngles(status.enrolledAngles)
        if (status.enrolled) {
          setPhase({ kind: 'all_done' })
          return
        }
        const next = status.remainingAngles[0]
        setPhase({ kind: 'ready', current: next })

        // Try camera; fall back to file picker on denial.
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user' },
            audio: false,
          })
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop())
            return
          }
          streamRef.current = stream
          if (videoRef.current) {
            videoRef.current.srcObject = stream
            await videoRef.current.play().catch(() => {})
          }
        } catch {
          if (!cancelled) setCameraDenied(true)
        }
      } catch {
        if (!cancelled) {
          setCameraDenied(true)
          setPhase({
            kind: 'ready',
            current: 'frontal',
            lastError: 'Could not load enrollment progress — try uploading a photo instead.',
          })
        }
      }
    })()
    return () => {
      cancelled = true
      stopStream()
    }
  }, [stopStream])

  const handleFinalizeResponse = useCallback(
    (resp: FinalizeResponse) => {
      setEnrolledAngles(resp.enrolledAngles)
      if (resp.enrolled) {
        stopStream()
        setPhase({ kind: 'all_done' })
        return
      }
      const next = resp.remainingAngles[0]
      setPhase({ kind: 'ready', current: next })
    },
    [stopStream],
  )

  const handleError = useCallback((err: unknown, current: Angle) => {
    const e = (err as ErrorResponse) || { error: 'unknown' }
    setPhase({ kind: 'ready', current, lastError: describeError(e) })
  }, [])

  // Capture from live video → JPEG → enroll
  const handleCameraCapture = useCallback(async () => {
    if (phase.kind !== 'ready') return
    const angle = phase.current
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return
    // Flip phase BEFORE the canvas draw so a double-tap can't both reach
    // drawImage. The disabled button is the primary guard, but this closes
    // the milliseconds-wide race between click handlers.
    setPhase({ kind: 'capturing' })
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      handleError({ error: 'canvas_context_failed' }, angle)
      return
    }
    ctx.drawImage(video, 0, 0, w, h)
    try {
      const blob = await blobFromCanvas(canvas)
      const resp = await captureAndEnroll(angle, blob)
      handleFinalizeResponse(resp)
    } catch (err) {
      handleError(err, angle)
    }
  }, [phase, handleFinalizeResponse, handleError])

  // File-input fallback (camera denied / older browser)
  const handleFilePick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (phase.kind !== 'ready') return
      const angle = phase.current
      const file = e.target.files?.[0]
      if (!file) return
      e.target.value = ''
      setPhase({ kind: 'capturing' })
      try {
        // Re-encode through canvas? No — server runs Sharp anyway. Just send the file.
        const resp = await captureAndEnroll(angle, file)
        handleFinalizeResponse(resp)
      } catch (err) {
        handleError(err, angle)
      }
    },
    [phase, handleFinalizeResponse, handleError],
  )

  // Defer redirect via effect (not render path) so the success state paints
  // exactly once and we don't schedule duplicate redirects on re-render.
  useEffect(() => {
    if (phase.kind !== 'all_done') return
    const t = setTimeout(() => router.replace(nextHref as never), 250)
    return () => clearTimeout(t)
  }, [phase.kind, router, nextHref])

  if (phase.kind === 'all_done') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          padding: '32px 0',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 99,
            background: 'var(--t-fresh-bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--t-fresh)',
          }}
        >
          <Icon name="check" size={28} />
        </div>
        <p
          className="display"
          style={{ fontSize: 24, lineHeight: 1.1, margin: 0 }}
        >
          You&apos;re set
        </p>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
          Redirecting…
        </p>
      </div>
    )
  }

  const current = phase.kind === 'ready' ? phase.current : null
  const lastError = phase.kind === 'ready' ? phase.lastError : undefined
  const stepNumber = current ? ANGLE_ORDER.indexOf(current) + 1 : 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Step tracker */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {ANGLE_ORDER.map((a) => {
          const done = enrolledAngles.includes(a)
          const isCurrent = a === current
          return (
            <span
              key={a}
              className={done ? 'chip chip-fresh' : 'chip'}
              style={
                done
                  ? { display: 'inline-flex', alignItems: 'center', gap: 4 }
                  : isCurrent
                    ? {
                        display: 'inline-flex',
                        alignItems: 'center',
                        border: '1.5px solid var(--ink)',
                        color: 'var(--ink)',
                        background: 'transparent',
                      }
                    : {
                        display: 'inline-flex',
                        alignItems: 'center',
                        border: '1px solid var(--rule)',
                        color: 'var(--muted)',
                        background: 'transparent',
                      }
              }
            >
              {done && (
                <Icon name="check" size={11} style={{ marginRight: 2 }} />
              )}
              {SHORT_BY_ANGLE[a]}
            </span>
          )
        })}
        <span
          style={{
            marginLeft: 8,
            fontSize: 11,
            color: 'var(--muted)',
            fontFamily: 'var(--sans)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          Step {stepNumber} of 3
        </span>
      </div>

      {/* Prompt heading */}
      <p
        className="display"
        style={{
          fontSize: 18,
          lineHeight: 1.2,
          margin: 0,
          textAlign: 'center',
        }}
      >
        {current ? PROMPT_BY_ANGLE[current] : ''}
      </p>

      {/* Video preview */}
      {!cameraDenied && (
        <div
          style={{
            overflow: 'hidden',
            borderRadius: 18,
            background: 'var(--ink)',
            border: '1px solid var(--rule)',
          }}
        >
          {/* biome-ignore lint/a11y/useMediaCaption: live camera preview, no caption track */}
          <video
            ref={videoRef}
            playsInline
            muted
            style={{
              display: 'block',
              width: '100%',
              aspectRatio: '1/1',
              objectFit: 'cover',
              transform: 'scaleX(-1)',
            }}
          />
        </div>
      )}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Camera unavailable notice */}
      {cameraDenied && (
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            padding: '12px 14px',
            background: 'var(--t-warm-bg)',
            border: '1px solid rgba(180,120,40,.25)',
            borderRadius: 12,
            color: 'var(--t-warm)',
          }}
        >
          <Icon name="warn" size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            Camera not available. You can upload a photo instead — face the
            direction the prompt asks for.
          </p>
        </div>
      )}

      {/* Error message */}
      {lastError && (
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
            padding: '12px 14px',
            background: 'var(--t-alarm-bg)',
            border: '1px solid rgba(154,48,39,.25)',
            borderRadius: 12,
            color: 'var(--t-alarm)',
          }}
        >
          <Icon name="warn" size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>{lastError}</p>
        </div>
      )}

      {/* Action button */}
      {!cameraDenied ? (
        <button
          type="button"
          disabled={phase.kind !== 'ready'}
          onClick={handleCameraCapture}
          className="btn btn-primary btn-block"
          style={{ minHeight: 52, fontSize: 16 }}
        >
          {phase.kind === 'capturing' ? 'Checking…' : 'Capture'}
        </button>
      ) : (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="user"
            style={{ display: 'none' }}
            onChange={handleFilePick}
          />
          <button
            type="button"
            disabled={phase.kind !== 'ready'}
            onClick={() => fileInputRef.current?.click()}
            className="btn btn-primary btn-block"
            style={{ minHeight: 52, fontSize: 16 }}
          >
            {phase.kind === 'capturing' ? 'Checking…' : 'Choose photo'}
          </button>
        </>
      )}
    </div>
  )
}
