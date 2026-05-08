import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/current-user'
import { getFaceEnrollment } from '@/lib/auth/face-enrollment'

// Lets the multi-angle scan UI recover state on cold load: which angles are
// already captured, which remain. Read by FaceScanEnroll on mount.

export const runtime = 'nodejs'

export async function GET(): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  const status = await getFaceEnrollment(user.id)
  console.log(
    JSON.stringify({
      event: 'face.enroll.status_check',
      userId: user.id,
      enrolledAngles: status.enrolledAngles,
    }),
  )
  return NextResponse.json(status)
}
