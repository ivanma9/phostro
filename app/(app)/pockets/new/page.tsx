import { redirect } from 'next/navigation'
import { PocketCreateForm } from '@/components/PocketCreateForm'
import { getCurrentUser } from '@/lib/auth/current-user'
import { getFaceEnrollment } from '@/lib/auth/face-enrollment'

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
    <main className="mx-auto max-w-md p-6">
      <h1 className="mb-4 text-2xl font-semibold">New pocket</h1>
      <PocketCreateForm />
    </main>
  )
}
