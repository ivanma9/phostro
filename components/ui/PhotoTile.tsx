import { I } from './Icon';

interface PhotoTileProps {
  src?: string;
  alt?: string;
  ratio?: string;
  name?: string;
  initial?: string;
  selected?: boolean;
  dim?: boolean;
  label?: string;
}

export function PhotoTile({
  src,
  alt = '',
  ratio = '1/1',
  name,
  initial,
  selected,
  dim,
  label,
}: PhotoTileProps) {
  return (
    <div style={{ position: 'relative', aspectRatio: ratio, overflow: 'hidden', background: '#EAE2CD' }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            ...(dim ? { filter: 'brightness(.6)' } : {}),
          }}
        />
      ) : (
        <div
          className="photo-ph"
          data-label={label ?? 'photo'}
          style={{ position: 'absolute', inset: 0 }}
        />
      )}
      {selected && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(181,72,32,.18)',
            boxShadow: 'inset 0 0 0 3px var(--accent)',
          }}
        />
      )}
      {selected && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: 22,
            height: 22,
            borderRadius: 99,
            background: 'var(--accent)',
            color: '#FFF8EE',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <I name="check" size={14} stroke={2.4} />
        </div>
      )}
      {name && (
        <span className="attrib">
          <span className="av">{initial ?? name[0]}</span>
          {name}
        </span>
      )}
    </div>
  );
}
