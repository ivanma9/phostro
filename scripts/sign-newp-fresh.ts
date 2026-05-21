import { config } from 'dotenv'
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import postgres from 'postgres'
config({ path: '.env' })
config({ path: '.env.local', override: true })
async function main() {
  const accountId = process.env.R2_ACCOUNT_ID!
  const bucket = process.env.R2_BUCKET!
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  })
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false })
  const photos = await sql<{ id: string; r2_key_preview: string }[]>`
    SELECT p.id, p.r2_key_preview
    FROM photos p
    JOIN events e ON e.id = p.event_id
    WHERE e.name = 'New p' AND p.r2_key_preview IS NOT NULL
    ORDER BY p.created_at DESC
  `
  const labels: Record<string, string> = {
    '73ef4169-878b-41bf-91bd-c37a33a96317': 'A (best match, distance 0.544)',
    '3ff2c4e7-1fc9-4756-8ee1-160a65165f98': 'B (distance 0.587)',
    'f738155d-b480-4210-b1a3-0f10cf01beb0': 'C (distance 0.858)',
    'cb32a59e-d32d-4555-88e0-9112b6f5c26a': 'D (distance 0.859)',
    '38a0d59c-be1e-4d2e-82fc-b2a34016722d': 'E (distance 0.948)',
  }
  for (const p of photos) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: p.r2_key_preview }))
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: p.r2_key_preview }), { expiresIn: 3600 })
      console.log(`Photo ${labels[p.id] ?? p.id}`)
      console.log(`  KEY OK: ${p.r2_key_preview}`)
      console.log(`  ${url}`)
      console.log()
    } catch (e: unknown) {
      console.log(`Photo ${labels[p.id] ?? p.id}`)
      console.log(`  KEY MISSING: ${p.r2_key_preview} (${(e as Error).message})`)
      console.log()
    }
  }
  await sql.end()
}
main().catch(e => { console.error(e); process.exit(1) })
