'use client';

import type { ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { I } from './Icon';
import { useToast } from './Toast';

interface ShareBlockProps {
  /** When provided, render the full QR + link UI. When absent, render `children` as CTA slot. */
  url?: string;
  /** E.g. '48 / 50' */
  remaining?: string;
  revoked?: boolean;
  onRevoke?: () => void;
  onRegenerate?: () => void;
  /** Rendered when `url` is not yet set — caller provides a "Get share link" button, etc. */
  children?: ReactNode;
}

export function ShareBlock({
  url,
  remaining,
  revoked,
  onRevoke,
  onRegenerate,
  children,
}: ShareBlockProps) {
  const { show } = useToast();

  async function handleCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      show('Link copied to clipboard', 'ok');
    } catch {
      show('Could not copy — try manually', 'err');
    }
  }

  if (!url) {
    return <div>{children}</div>;
  }

  // Show just the hostname+path for the pill label
  let displayUrl = url;
  try {
    const parsed = new URL(url);
    displayUrl = parsed.host + parsed.pathname;
  } catch {
    // keep as-is if not a valid absolute URL
  }

  return (
    <div
      style={{
        background: revoked ? 'var(--t-alarm-bg)' : 'var(--paper-2)',
        border: '1px solid ' + (revoked ? 'rgba(154,48,39,.25)' : 'var(--rule)'),
        borderRadius: 22,
        padding: 20,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 18,
        alignItems: 'center',
      }}
    >
      <div
        style={{
          width: 168,
          height: 168,
          borderRadius: 8,
          overflow: 'hidden',
          flexShrink: 0,
          background: 'var(--surface)',
          padding: 8,
        }}
      >
        <QRCodeSVG
          value={url}
          size={152}
          bgColor="transparent"
          fgColor="var(--ink)"
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div className="eyebrow">{revoked ? 'Share link · revoked' : 'Share link'}</div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            background: 'var(--surface)',
            border: '1px solid var(--rule)',
            borderRadius: 999,
            fontFamily: 'ui-monospace, JetBrains Mono, monospace',
            fontSize: 12.5,
          }}
        >
          <I name="link" size={14} />
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textDecoration: revoked ? 'line-through' : 'none',
              color: revoked ? 'var(--muted)' : 'inherit',
            }}
          >
            {displayUrl}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ minHeight: 32, padding: '0 10px' }}
            disabled={revoked}
            onClick={handleCopy}
          >
            <I name="copy" size={14} /> Copy
          </button>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 11.5,
            color: 'var(--muted)',
          }}
        >
          {remaining && (
            <>
              <span>
                <span className="num">{remaining}</span> uploads remaining
              </span>
              <span style={{ width: 3, height: 3, background: 'var(--muted-2)', borderRadius: 99 }} />
            </>
          )}
          {revoked ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ minHeight: 28, padding: '0 10px' }}
              onClick={onRegenerate}
            >
              <I name="refresh" size={12} /> Regenerate
            </button>
          ) : (
            <button
              type="button"
              style={{
                background: 'none',
                border: 0,
                color: 'var(--t-alarm)',
                cursor: 'pointer',
                padding: 0,
                fontWeight: 500,
                fontSize: 11.5,
              }}
              onClick={onRevoke}
            >
              Revoke
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
