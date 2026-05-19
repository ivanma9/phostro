import { Suspense } from 'react'
import Link from 'next/link'
import { SignInForm } from '@/components/SignInForm'
import { ToastProvider } from '@/components/ui/Toast'
import { Logo } from '@/components/ui/Logo'

export default function SignInPage() {
  return (
    <ToastProvider>
      <main
        style={{
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 16px',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 420,
            padding: '40px 28px 24px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Logo size={26} />

          <Suspense fallback={<p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 56 }}>Loading&hellip;</p>}>
            <SignInForm />
          </Suspense>

          <div
            style={{
              marginTop: 'auto',
              paddingTop: 32,
              fontSize: 11,
              color: 'var(--muted)',
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            By signing in you agree to the{' '}
            <Link href="/tos" style={{ color: 'var(--ink-soft)', textDecoration: 'underline' }}>
              Terms
            </Link>
            .
          </div>
        </div>
      </main>
    </ToastProvider>
  )
}
