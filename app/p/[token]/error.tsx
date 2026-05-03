'use client'

export default function ContributorError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">This share link isn&apos;t available anymore.</h1>
      <p className="text-sm text-gray-500">
        {error.message || 'The link may have expired or been revoked.'}
      </p>
      <button
        type="button"
        onClick={unstable_retry}
        className="rounded bg-black px-4 py-2 text-sm text-white"
      >
        Try again
      </button>
    </main>
  )
}
