import { redirect } from 'next/navigation'
import { FaceScanEnroll } from '@/components/FaceScanEnroll'
import { getCurrentUser } from '@/lib/auth/current-user'

export default async function FaceEnrollPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/signin?next=/me/face/enroll')

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-2xl font-semibold">Set up face matching</h1>
      <p className="mt-2 text-sm text-gray-600">
        Three quick captures so we can find you in shared photos. Look straight, then turn your
        head left, then right.
      </p>
      <div className="mt-6">
        <FaceScanEnroll />
      </div>
    </main>
  )
}
