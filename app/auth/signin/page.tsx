import { Suspense } from 'react'
import { SignInForm } from '@/components/SignInForm'

export default function SignInPage() {
  return (
    <main className="mx-auto max-w-sm p-6 pt-20">
      <h1 className="mb-4 text-2xl font-semibold">Sign in</h1>
      <Suspense fallback={<p className="text-sm text-gray-500">Loading…</p>}>
        <SignInForm />
      </Suspense>
    </main>
  )
}
