import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PocketCreateForm } from '@/components/PocketCreateForm'
import { getCurrentUser } from '@/lib/auth/current-user'
import { getFaceEnrollment } from '@/lib/auth/face-enrollment'
import { AppBar } from '@/components/ui/AppBar'
import { I } from '@/components/ui/Icon'
import { ToastProvider } from '@/components/ui/Toast'

export default async function NewPocketPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/signin?next=/pockets/new')
  // Pocket creation requires a 3-of-3 face scan. Bounce to the dedicated
  // enrollment route if the user hasn't completed it; they'll come back here.
  const enrollment = await getFaceEnrollment(user.id)
  if (!enrollment.enrolled) {
    redirect('/me/face/enroll?next=/pockets/new')
  }

  return (
    <ToastProvider>
      <div style={{ minHeight: '100dvh', background: 'var(--paper)' }}>
        <AppBar
          title="New pocket"
          leading={
            <Link
              href="/"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 36,
                height: 36,
                borderRadius: 99,
                background: 'none',
                border: 0,
                color: 'var(--ink)',
                cursor: 'pointer',
                textDecoration: 'none',
              }}
              aria-label="Back"
            >
              <I name="back" size={20} />
            </Link>
          }
        />
        <main
          style={{
            maxWidth: 440,
            margin: '0 auto',
            padding: '20px 20px 48px',
            background: 'var(--paper)',
          }}
        >
          <PocketCreateForm />
        </main>
      </div>
    </ToastProvider>
  )
}
