import { I } from './Icon';

interface UploadRowProps {
  name: string;
  size: string;
  pct: number;
  active?: boolean;
  status?: 'queued' | 'error';
  err?: string;
  onCancel?: () => void;
}

export function UploadRow({ name, size, pct, active, status, err, onCancel }: UploadRowProps) {
  const isErr = status === 'error';
  const isQueued = status === 'queued';
  const isDone = pct >= 100;

  const statusText = isErr
    ? err
    : isQueued
    ? 'Queued — waiting on signal'
    : isDone
    ? 'Uploaded'
    : `${pct}% · ${active ? 'uploading' : 'paused'}`;

  const barColor = isErr ? 'var(--t-alarm)' : isDone ? 'var(--t-fresh)' : 'var(--accent)';
  const cancelIcon = isErr ? 'refresh' : isDone ? 'check' : 'close';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        background: 'var(--surface)',
        border: '1px solid ' + (isErr ? 'rgba(154,48,39,.3)' : 'var(--rule)'),
        borderRadius: 10,
      }}
    >
      <div
        className="photo-ph"
        data-label=""
        style={{ width: 40, height: 40, borderRadius: 6, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {name}
          </span>
          <span className="num" style={{ fontSize: 11, color: 'var(--muted)' }}>
            {size}
          </span>
        </div>
        <div
          style={{
            marginTop: 6,
            height: 4,
            background: 'var(--rule)',
            borderRadius: 99,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: pct + '%',
              background: barColor,
              transition: 'width .3s',
            }}
          />
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: isErr ? 'var(--t-alarm)' : 'var(--muted)',
          }}
        >
          {statusText}
        </div>
      </div>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel"
        style={{
          background: 'none',
          border: 0,
          color: 'var(--muted)',
          cursor: 'pointer',
          padding: 6,
        }}
      >
        <I name={cancelIcon} size={16} />
      </button>
    </div>
  );
}
