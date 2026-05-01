import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

let cached: S3Client | null = null

function client(): S3Client {
  if (cached) return cached
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials missing')
  }
  cached = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // R2 rejects the AWS SDK v3 default `x-amz-checksum-crc32` header that
    // gets baked into presigned PUT URLs; opt out so browser uploads work.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return cached
}

function bucket(): string {
  const b = process.env.R2_BUCKET
  if (!b) throw new Error('R2_BUCKET not set')
  return b
}

export async function createPresignedPutUrl(
  key: string,
  contentType: string,
  expiresInSeconds: number,
): Promise<string> {
  const cmd = new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType })
  return getSignedUrl(client(), cmd, { expiresIn: expiresInSeconds })
}

export async function createPresignedGetUrl(
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: bucket(), Key: key })
  return getSignedUrl(client(), cmd, { expiresIn: expiresInSeconds })
}

export async function headObject(key: string): Promise<{ contentLength: number } | null> {
  try {
    const out = await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
    return { contentLength: out.ContentLength ?? 0 }
  } catch (e: unknown) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'name' in e &&
      ((e as { name: string }).name === 'NotFound' || (e as { name: string }).name === 'NoSuchKey')
    ) {
      return null
    }
    throw e
  }
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const out = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
  if (!out.Body) throw new Error('R2 GetObject returned empty body')
  const bytes = await (
    out.Body as { transformToByteArray: () => Promise<Uint8Array> }
  ).transformToByteArray()
  return Buffer.from(bytes)
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  )
}

export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
}
