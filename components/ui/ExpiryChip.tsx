'use client';

import { useEffect, useState } from 'react';

type Variant = 'fresh' | 'warm' | 'alarm';

interface ExpiryChipProps {
  /** Unix milliseconds — preferred; component computes daysLeft/hoursLeft from this */
  expiresAtMs?: number;
  /** Static fallback when no live timestamp is available */
  daysLeft?: number;
  hoursLeft?: number;
  variant?: Variant;
}

function deriveVariant(days: number): Variant {
  if (days >= 3) return 'fresh';
  if (days >= 1) return 'warm';
  return 'alarm';
}

function computeFromMs(expiresAtMs: number): { days: number; hours: number } {
  const diffMs = expiresAtMs - Date.now();
  const diffHours = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60)));
  return { days: Math.floor(diffHours / 24), hours: diffHours % 24 };
}

export function ExpiryChip({ expiresAtMs, daysLeft, hoursLeft = 0, variant }: ExpiryChipProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Render a neutral placeholder until client-side clock is available to avoid
  // server/client hydration mismatch when expiresAtMs is used.
  if (!mounted && expiresAtMs != null) {
    return <span className="chip chip-ghost">…</span>;
  }

  let days = daysLeft ?? 0;
  let hours = hoursLeft;

  if (expiresAtMs != null) {
    const computed = computeFromMs(expiresAtMs);
    days = computed.days;
    hours = computed.hours;
  }

  const v: Variant = variant ?? deriveVariant(days);

  const label =
    days > 0
      ? `${days}d ${hours}h left`
      : hours > 0
      ? `${hours}h left`
      : 'expires now';

  return (
    <span className={`chip chip-${v}`}>
      <span className="dot" style={{ opacity: 0.7 }} />
      {label}
    </span>
  );
}
