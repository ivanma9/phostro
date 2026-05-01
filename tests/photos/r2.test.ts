import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  createPresignedGetUrl,
  createPresignedPutUrl,
  deleteObject,
  getObjectBuffer,
  headObject,
  putObject,
} from '@/lib/photos/r2'

const s3Mock = mockClient(S3Client)

beforeEach(() => {
  s3Mock.reset()
  process.env.R2_BUCKET = 'phostro-photos'
  process.env.R2_ACCOUNT_ID = 'aaaa'
  process.env.R2_ACCESS_KEY_ID = 'bbbb'
  process.env.R2_SECRET_ACCESS_KEY = 'cccc'
})

afterEach(() => s3Mock.reset())

test('createPresignedPutUrl returns a URL targeting the right key + content-type', async () => {
  const url = await createPresignedPutUrl('events/E/pending/P.bin', 'image/jpeg', 60)
  expect(url).toContain('phostro-photos')
  expect(url).toContain('events/E/pending/P.bin')
  expect(url).toContain('X-Amz-Signature')
})

test('createPresignedGetUrl returns a URL that points at the key', async () => {
  const url = await createPresignedGetUrl('events/E/preview/P.jpg', 300)
  expect(url).toContain('events/E/preview/P.jpg')
  expect(url).toContain('X-Amz-Signature')
})

test('headObject returns content-length when present', async () => {
  s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1234 })
  expect(await headObject('any')).toEqual({ contentLength: 1234 })
})

test('headObject returns null when key missing (404)', async () => {
  s3Mock.on(HeadObjectCommand).rejects({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
  expect(await headObject('any')).toBeNull()
})

test('getObjectBuffer concatenates streamed chunks', async () => {
  const body = {
    transformToByteArray: async () => new Uint8Array([1, 2, 3, 4]),
  }
  s3Mock.on(GetObjectCommand).resolves({ Body: body as never })
  const buf = await getObjectBuffer('any')
  expect(Array.from(buf)).toEqual([1, 2, 3, 4])
})

test('putObject sends a PutObjectCommand with body and content-type', async () => {
  s3Mock.on(PutObjectCommand).resolves({})
  await putObject('events/E/preview/P.jpg', Buffer.from('x'), 'image/jpeg')
  const calls = s3Mock.commandCalls(PutObjectCommand)
  expect(calls).toHaveLength(1)
  expect(calls[0].args[0].input.Key).toBe('events/E/preview/P.jpg')
  expect(calls[0].args[0].input.ContentType).toBe('image/jpeg')
})

test('deleteObject sends a DeleteObjectCommand', async () => {
  s3Mock.on(DeleteObjectCommand).resolves({})
  await deleteObject('any')
  expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1)
})
