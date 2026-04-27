import Link from 'next/link'

export default function AuthErrorPage() {
  return (
    <main className="mx-auto max-w-sm p-6 pt-20">
      <h1 className="mb-2 text-xl font-semibold">Link expired or invalid</h1>
      <p className="mb-4 text-sm text-gray-600">Try requesting a new magic link.</p>
      <Link href="/auth/signin" className="text-blue-600 underline">
        Back to sign-in
      </Link>
    </main>
  )
}
