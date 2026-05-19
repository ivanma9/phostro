import Link from 'next/link';
import { ExpiryChip } from './ExpiryChip';
import { PhotoTile } from './PhotoTile';

interface PocketCardProps {
  name: string;
  role: 'host' | 'guest';
  photoCount: number;
  expiresAtMs?: number;
  expired?: boolean;
  /** Up to 4 presigned URLs; missing slots become placeholders */
  thumbs?: string[];
  href?: string;
}

export function PocketCard({
  name,
  role,
  photoCount,
  expiresAtMs,
  expired,
  thumbs = [],
  href,
}: PocketCardProps) {
  const card = (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--rule)',
        borderRadius: 14,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        opacity: expired ? 0.7 : 1,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span
              className="chip chip-ghost"
              style={{ textTransform: 'uppercase', letterSpacing: '.14em', fontSize: 9.5 }}
            >
              {role}
            </span>
            {expired ? (
              <span className="chip" style={{ background: 'var(--rule-soft)', color: 'var(--muted)' }}>
                expired
              </span>
            ) : expiresAtMs != null ? (
              <ExpiryChip expiresAtMs={expiresAtMs} />
            ) : null}
          </div>
          <div className="display" style={{ fontSize: 22, lineHeight: 1.1, letterSpacing: '-0.015em' }}>
            {name}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
            <span className="num">{photoCount}</span> photos
          </div>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 3,
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <PhotoTile key={i} src={thumbs[i]} ratio="1/1" />
        ))}
      </div>
    </div>
  );

  if (href) {
    return (
      <Link href={href} style={{ textDecoration: 'none' }}>
        {card}
      </Link>
    );
  }

  return card;
}
