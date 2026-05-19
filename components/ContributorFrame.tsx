'use client'

import { useState } from 'react'
import { ContributorUpload } from './ContributorUpload'
import { Eyebrow } from '@/components/ui/Eyebrow'
import { Icon } from '@/components/ui/Icon'
import { PhotoTile } from '@/components/ui/PhotoTile'

/**
 * Wraps ContributorUpload in the dashed dropzone card while idle/uploading.
 * When upload completes, replaces the card with a full-width done state —
 * matching the GuestUploaded design pattern (green check → headline → thumbnails → "Add more").
 */
export function ContributorFrame({
  token,
  eventName,
  hostFirstName,
}: {
  token: string
  eventName: string
  hostFirstName: string
}) {
  const [doneCount, setDoneCount] = useState<number | null>(null)

  if (doneCount !== null) {
    return (
      <div style={{ padding: '0 20px' }}>
        <div style={{ textAlign: 'center', paddingBottom: 16 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 99,
              background: 'var(--t-fresh-bg)',
              color: 'var(--t-fresh)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 12,
            }}
          >
            <Icon name="check" size={28} stroke={2.2} />
          </div>
          <Eyebrow>Thanks!</Eyebrow>
          <h2
            className="display"
            style={{ fontSize: 30, lineHeight: 1.05, margin: '6px 0 6px' }}
          >
            <span className="num">
              {doneCount} {doneCount === 1 ? 'photo' : 'photos'}
            </span>{' '}
            on the way to{' '}
            <em className="display-it" style={{ color: 'var(--accent)' }}>
              {hostFirstName}
            </em>
          </h2>
          <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
            You can add more, or close this tab. We&rsquo;ll keep them safe —
            and delete them when the pocket expires.
          </p>
        </div>

        {doneCount > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Your uploads
            </div>
            <div className="grid-3" style={{ gap: 6 }}>
              {Array.from({ length: Math.min(doneCount, 9) }).map((_, i) => (
                <div key={i} style={{ position: 'relative' }}>
                  <PhotoTile ratio="1/1" />
                  <div
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      width: 18,
                      height: 18,
                      borderRadius: 99,
                      background: 'var(--t-fresh)',
                      color: '#FFF8EE',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name="check" size={11} stroke={2.6} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          className="btn btn-primary btn-block"
          style={{ minHeight: 52 }}
          onClick={() => setDoneCount(null)}
        >
          <Icon name="plus" size={16} /> Add more photos
        </button>
      </div>
    )
  }

  return (
    <div style={{ padding: '0 20px' }}>
      <div
        style={{
          marginTop: 8,
          padding: '28px 20px',
          background: 'var(--paper-2)',
          border: '2px dashed rgba(181,72,32,.35)',
          borderRadius: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 99,
            background: 'var(--accent)',
            color: '#FFF8EE',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--sh-3)',
          }}
        >
          <Icon name="upload" size={26} stroke={2} />
        </div>
        <div className="display" style={{ fontSize: 22, lineHeight: 1.1 }}>
          Drop in your photos
        </div>
        <p
          style={{
            fontSize: 12.5,
            color: 'var(--muted)',
            lineHeight: 1.5,
            maxWidth: '28ch',
          }}
        >
          Up to <span className="num">10 MB</span> per photo · JPEG, PNG, HEIC
        </p>
        <ContributorUpload
          token={token}
          hostFirstName={hostFirstName}
          onDone={(added) => setDoneCount(added)}
        />
      </div>
    </div>
  )
}
