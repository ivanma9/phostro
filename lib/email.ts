import { Resend } from 'resend'

let cached: Resend | null = null

function getClient(): Resend {
  if (cached) return cached
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY is not set')
  cached = new Resend(key)
  return cached
}

export async function sendMagicLinkEmail({ to, link }: { to: string; link: string }) {
  const { data, error } = await getClient().emails.send({
    from: 'Photo Courier <onboarding@resend.dev>',
    to,
    subject: 'Sign in to Photo Courier',
    html: `<p>Click to sign in: <a href="${link}">${link}</a></p><p>Expires in 15 minutes.</p>`,
  })
  if (error) throw new Error(`Resend error: ${error.message}`)
  if (!data) throw new Error('Resend returned no data')
  return data
}
