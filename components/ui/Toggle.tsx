'use client';

interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  id?: string;
  'aria-label'?: string;
}

export function Toggle({ on, onChange, id, 'aria-label': ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      style={{
        width: 44,
        height: 26,
        borderRadius: 99,
        background: on ? 'var(--accent)' : 'var(--rule)',
        position: 'relative',
        flexShrink: 0,
        transition: 'background .2s',
        border: 0,
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: on ? 21 : 3,
          width: 20,
          height: 20,
          borderRadius: 99,
          background: '#FFF8EE',
          boxShadow: '0 1px 3px rgba(0,0,0,.18)',
          transition: 'left .2s',
          display: 'block',
        }}
      />
    </button>
  );
}
