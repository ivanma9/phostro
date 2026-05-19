export type IconName =
  | 'plus' | 'arrow' | 'back' | 'close' | 'check' | 'upload' | 'camera'
  | 'copy' | 'link' | 'download' | 'trash' | 'more' | 'clock' | 'qr'
  | 'warn' | 'wifi' | 'refresh' | 'eye' | 'user' | 'lock' | 'mail'
  | 'grid' | 'search' | 'heart' | 'share' | 'scan';

const ICONS: Record<IconName, string> = {
  plus:    'M12 5v14M5 12h14',
  arrow:   'M5 12h14M13 6l6 6-6 6',
  back:    'M19 12H5M11 6l-6 6 6 6',
  close:   'M6 6l12 12M18 6L6 18',
  check:   'M5 12.5l4.5 4.5L19 7',
  upload:  'M12 16V4m0 0l-5 5m5-5l5 5M4 18v2a1 1 0 001 1h14a1 1 0 001-1v-2',
  camera:  'M3 8a2 2 0 012-2h2l2-2h6l2 2h2a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V8z M12 17a4 4 0 100-8 4 4 0 000 8z',
  copy:    'M9 9V5a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-4 M5 11h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2z',
  link:    'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1 M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1',
  download:'M12 4v12m0 0l-5-5m5 5l5-5M4 18v2a1 1 0 001 1h14a1 1 0 001-1v-2',
  trash:   'M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13M10 11v7M14 11v7',
  more:    'M5 12h.01M12 12h.01M19 12h.01',
  clock:   'M12 7v5l3 2 M12 22a10 10 0 100-20 10 10 0 000 20z',
  qr:      'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3zM14 19h2',
  warn:    'M12 9v4m0 4h.01M10.3 3.86l-8.4 14.62A2 2 0 003.6 21h16.8a2 2 0 001.7-2.52L13.7 3.86a2 2 0 00-3.4 0z',
  wifi:    'M5 12.5a10 10 0 0114 0M8.5 16a6 6 0 017 0M12 19.5h.01',
  refresh: 'M3 12a9 9 0 0115-6.7l3 2.7M21 4v5h-5M21 12a9 9 0 01-15 6.7l-3-2.7M3 20v-5h5',
  eye:     'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 100-6 3 3 0 000 6z',
  user:    'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2 M12 11a4 4 0 100-8 4 4 0 000 8z',
  lock:    'M6 10V7a6 6 0 0112 0v3 M5 10h14a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1z',
  mail:    'M3 7l9 6 9-6M3 7v10a2 2 0 002 2h14a2 2 0 002-2V7M3 7a2 2 0 012-2h14a2 2 0 012 2',
  grid:    'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  search:  'M11 19a8 8 0 100-16 8 8 0 000 16z M21 21l-4.3-4.3',
  heart:   'M20.8 4.6a5.5 5.5 0 00-7.8 0L12 5.6l-1-1a5.5 5.5 0 10-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 000-7.8z',
  share:   'M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7 M16 6l-4-4-4 4 M12 2v13',
  scan:    'M3 7V5a2 2 0 012-2h2 M17 3h2a2 2 0 012 2v2 M21 17v2a2 2 0 01-2 2h-2 M7 21H5a2 2 0 01-2-2v-2 M7 12h10',
};

interface IconProps {
  name: IconName;
  size?: number;
  stroke?: number;
  fill?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 18, stroke = 1.6, fill = 'none', style }: IconProps) {
  const d = ICONS[name] ?? ICONS.more;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {d.split(' M').map((segment, i) => (
        <path key={i} d={i === 0 ? segment : 'M' + segment} />
      ))}
    </svg>
  );
}

// Convenience alias used throughout the design source
export function I({ name, ...rest }: IconProps) {
  return <Icon name={name} {...rest} />;
}
