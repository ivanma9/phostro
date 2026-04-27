import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/current-user'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ user: null }, { status: 401 })
  return NextResponse.json({ user: { id: user.id, name: user.name, contact: user.contact } })
}
