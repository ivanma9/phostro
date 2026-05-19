'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type ToastKind = 'ok' | 'err' | 'info';

interface ToastState {
  message: string;
  kind: ToastKind;
  id: number;
}

interface ToastContextValue {
  show: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string, kind: ToastKind = 'ok') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, kind, id: Date.now() });
    timerRef.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast && (
        <div
          key={toast.id}
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            pointerEvents: 'none',
          }}
        >
          <ToastPill kind={toast.kind}>{toast.message}</ToastPill>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

// Standalone presentational pill — can be used directly in design compositions
interface ToastPillProps {
  kind?: ToastKind;
  children: React.ReactNode;
}

export function ToastPill({ kind = 'ok', children }: ToastPillProps) {
  const dotColor =
    kind === 'err' ? 'var(--err)' : kind === 'info' ? 'var(--info)' : 'var(--ok)';
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderRadius: 999,
        background: 'var(--ink)',
        color: 'var(--paper)',
        fontSize: 13.5,
        fontWeight: 500,
        boxShadow: 'var(--sh-modal)',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 99, background: dotColor }} />
      {children}
    </div>
  );
}
