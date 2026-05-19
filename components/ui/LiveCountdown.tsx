'use client';

import { useEffect, useRef, useState } from 'react';
import { CountdownDisplay } from './CountdownDisplay';

type Variant = 'fresh' | 'warm' | 'alarm';

interface LiveCountdownProps {
  expiresAtMs: number;
  label?: string;
}

function compute(expiresAtMs: number): { days: number; hours: number; mins: number; variant: Variant } {
  const diffMs = Math.max(0, expiresAtMs - Date.now());
  const totalMins = Math.floor(diffMs / (1000 * 60));
  const days = Math.floor(totalMins / (60 * 24));
  const hours = Math.floor((totalMins % (60 * 24)) / 60);
  const mins = totalMins % 60;
  const variant: Variant = days >= 3 ? 'fresh' : days >= 1 ? 'warm' : 'alarm';
  return { days, hours, mins, variant };
}

export function LiveCountdown({ expiresAtMs, label }: LiveCountdownProps) {
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState(() => compute(expiresAtMs));
  const hiddenRef = useRef(false);

  useEffect(() => {
    // Flip mounted so the live (client-clock) value renders after hydration,
    // avoiding server/client mismatch on seconds-level rollover.
    setMounted(true);
    setState(compute(expiresAtMs));

    const onVisChange = () => {
      hiddenRef.current = document.hidden;
    };
    document.addEventListener('visibilitychange', onVisChange);

    const id = setInterval(() => {
      if (!hiddenRef.current) {
        setState(compute(expiresAtMs));
      }
    }, 60_000); // once per minute — adequate for a 7-day clock

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [expiresAtMs]);

  if (!mounted) {
    return <CountdownDisplay days={0} hours={0} mins={0} variant="fresh" label={label} />;
  }

  return <CountdownDisplay {...state} label={label} />;
}
