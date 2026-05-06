import { redirect } from 'next/navigation'
import { PocketCreateForm } from '@/components/PocketCreateForm'
import { getCurrentUser } from '@/lib/auth/current-user'

export default async function NewPocketPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/signin?next=/pockets/new')
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="mb-4 text-2xl font-semibold">New pocket</h1>
      <PocketCreateForm />
    </main>
  )
}
