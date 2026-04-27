import { redirect } from 'next/navigation'
import { EventCreateForm } from '@/components/EventCreateForm'
import { getCurrentUser } from '@/lib/auth/current-user'

export default async function NewEventPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/auth/signin')
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="mb-4 text-2xl font-semibold">New event</h1>
      <EventCreateForm />
    </main>
  )
}
