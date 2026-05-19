type Variant = 'fresh' | 'warm' | 'alarm';

interface CountdownDisplayProps {
  days: number;
  hours: number;
  mins: number;
  variant?: Variant;
  label?: string;
}

export function CountdownDisplay({
  days,
  hours,
  mins,
  variant = 'fresh',
  label = 'until everything auto-deletes',
}: CountdownDisplayProps) {
  const color = `var(--t-${variant})`;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span className="num" style={{ fontSize: 64, lineHeight: 1, color, fontWeight: 300 }}>{days}</span>
        <span className="display-it" style={{ fontSize: 22, color: 'var(--muted)' }}>d</span>
        <span className="num" style={{ fontSize: 64, lineHeight: 1, color, fontWeight: 300, marginLeft: 10 }}>
          {String(hours).padStart(2, '0')}
        </span>
        <span className="display-it" style={{ fontSize: 22, color: 'var(--muted)' }}>h</span>
        <span className="num" style={{ fontSize: 64, lineHeight: 1, color, fontWeight: 300, marginLeft: 10 }}>
          {String(mins).padStart(2, '0')}
        </span>
        <span className="display-it" style={{ fontSize: 22, color: 'var(--muted)' }}>m</span>
      </div>
      <span className="eyebrow" style={{ flexBasis: '100%' }}>{label}</span>
    </div>
  );
}
