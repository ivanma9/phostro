import { notFound, redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/current-user'
import { joinEvent } from '@/lib/events/join'

export default async function JoinEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) redirect(`/auth/signin?next=/events/${id}/join`)

  const result = await joinEvent(id, user.id)
  if (result === 'not_found') notFound()
  redirect(`/events/${id}`)
}
