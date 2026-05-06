export const metadata = {
  title: 'Terms of Service — Photo Courier',
}

export default function TermsOfServicePage() {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Terms of Service</h1>
      <p className="mb-3 text-sm text-gray-700">
        By uploading a photo through a share link, you confirm you have permission to share that
        photo with the person who sent you the link.
      </p>
      <p className="mb-3 text-sm text-gray-700">
        Photos you upload are visible only to the share link&apos;s owner. We use face matching to
        filter the owner&apos;s feed; we do not link faces back to identity for any other person.
      </p>
      <p className="text-sm text-gray-700">
        This is a closed beta. For questions, reply to whoever sent you the link.
      </p>
    </main>
  )
}
