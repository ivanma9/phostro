import type { ReactNode } from 'react';

interface AppBarProps {
  title?: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export function AppBar({ title, subtitle, leading, trailing }: AppBarProps) {
  return (
    <div className="app-bar">
      {leading}
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: -0.01 }}>{title}</div>
        )}
        {subtitle && (
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{subtitle}</div>
        )}
      </div>
      {trailing}
    </div>
  );
}
