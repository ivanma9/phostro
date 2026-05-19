import { I } from './Icon';

interface SelectionBarProps {
  count: number;
  onSave?: () => void;
  onShare?: () => void;
  onDelete?: () => void;
}

export function SelectionBar({ count, onSave, onShare, onDelete }: SelectionBarProps) {
  const actionBtn: React.CSSProperties = {
    background: 'none',
    border: 0,
    color: 'inherit',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 99,
    cursor: 'pointer',
    fontSize: 12.5,
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 8px 8px 16px',
        background: 'var(--ink)',
        color: 'var(--paper)',
        borderRadius: 999,
        boxShadow: 'var(--sh-modal)',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 500 }}>
        <span className="num">{count}</span> selected
      </span>
      <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.18)' }} />
      <button type="button" style={actionBtn} onClick={onSave}>
        <I name="download" size={14} /> Save
      </button>
      <button type="button" style={actionBtn} onClick={onShare}>
        <I name="share" size={14} /> Share
      </button>
      <button
        type="button"
        style={{
          ...actionBtn,
          background: 'rgba(224,115,96,.18)',
          color: '#E07360',
          padding: '6px 12px',
        }}
        onClick={onDelete}
      >
        <I name="trash" size={14} /> Delete
      </button>
    </div>
  );
}
