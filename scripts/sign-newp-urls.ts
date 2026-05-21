import { config } from 'dotenv'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
config({ path: '.env' })
config({ path: '.env.local', override: true })
async function main() {
  const accountId = process.env.R2_ACCOUNT_ID!
  const bucket = process.env.R2_BUCKET!
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  })
  const event = '2f833778-ebc1-405e-a390-fbce5790fd5e'
  const photos = [
    { d: 0.544, id: '73ef4169-878b-41bf-91bd-c37a33a96317' },
    { d: 0.587, id: '3ff2c4e7-1fc9-4756-8ee1-160a65165f98' },
    { d: 0.858, id: 'f738155d-b480-4210-b1a3-0f10cf01beb0' },
    { d: 0.859, id: 'cb32a59e-d32d-4555-88e0-9112b6f5c26a' },
    { d: 0.948, id: '38a0d59c-be1e-4d2e-82fc-b2a34016722d' },
  ]
  for (const p of photos) {
    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: `events/${event}/preview/${p.id}.jpg` }), { expiresIn: 3600 })
    console.log(`distance ${p.d}: ${url}`)
    console.log()
  }
}
main().catch(e => { console.error(e); process.exit(1) })
