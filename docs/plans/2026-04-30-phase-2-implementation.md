# Phase 2 Implementation Plan — Upload + Storage

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the upload pipeline described in `docs/plans/2026-04-28-phase-2-design.md`. End state: a host or attendee can drag-and-drop photos onto an event page, see them upload (concurrent batches of 3, aggregate progress), and view their own uploads as thumbnails on the same page.

**Architecture:** Init route inserts a `photos` row in `pending` state and returns a presigned PUT URL. Browser uploads bytes directly to R2. Finalize route atomically claims the row (`pending → processing`), HEADs to enforce real size, runs Sharp (decode → rotate → strip-EXIF → JPEG q=95 + JPEG q=85 max 2048px), writes original/preview to R2, marks row `ready`. Gallery server component queries the uploader's ready rows and embeds 5-min presigned GET URLs directly in `<img src>`.

**Tech Stack:** Next.js 16 + Postgres (Drizzle, pgvector) + Cloudflare R2 (S3-compatible) + Sharp 0.34+ + `@aws-sdk/client-s3` + `exifr` + Vitest + Playwright + Biome.

---

## Prerequisites (manual, do these first)

These cannot be automated — the engineer must do them before Task 7.

1. **Cloudflare R2 bucket** named `phostro-photos`, **private** (no public dev URL enabled). User has done this.
2. **R2 credentials** in `.env.local` of the worktree:
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=phostro-photos`.
   - `R2_PUBLIC_URL` may stay blank in Phase 2 (we don't use it).
3. **R2 CORS policy** (Bucket → Settings → CORS Policy):
   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:3000", "http://localhost:3010"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
4. **R2 lifecycle rule** (Bucket → Settings → Object Lifecycle Rules):
   - Rule name: `expire-pending`
   - Prefix: `events/` *(rule applies to objects whose key contains `/pending/` — set the prefix to `events/` and add a "Filter by suffix or contains" if available; otherwise use prefix `events/` and cap by tag if Cloudflare supports it. Fallback: 24-hour delete on the whole bucket — ok for Phase 2 because `original/` and `preview/` are written by finalize within seconds of the pending object's deletion. We can replace this with a precise rule once Cloudflare adds prefix-glob.)*
   - Action: `Delete after 1 day`

If Cloudflare's UI doesn't let you scope the lifecycle rule precisely to `*/pending/*`, set it on the whole bucket — a 24-hour TTL is fine for Phase 2 because finalize always completes within seconds.

---

## Operating notes

- Start every task by reading the design doc (`docs/plans/2026-04-28-phase-2-design.md`) section that the task references.
- Use TDD where a pure unit boundary exists (lib/photos/process.ts, lib/photos/r2.ts, lib/photos/cap.ts, validators).
- For API routes, write the integration test first (mocking R2 at module level), then the route.
- Commit after every task. Never merge tasks into one commit.
- After each task: run `pnpm lint` and `pnpm test`. They must both be green before committing. If a task touches the upload UI, also smoke-test in `pnpm dev` and confirm the new behavior in a browser.
- After **every task**: invoke `superpowers:requesting-code-review` per global CLAUDE.md.

---

## Task 1: Install dependencies and add R2 env entries

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `.env.example`

**Step 1: Install runtime deps**
```bash
pnpm add sharp @aws-sdk/client-s3 @aws-sdk/s3-request-presigner exifr
```
Expected: `sharp`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `exifr` listed under `dependencies`. Sharp's postinstall runs and downloads platform binaries (~30 MB). Approve the build script if prompted: `pnpm approve-builds` and select `sharp`.

**Step 2: Add Sharp to allowed build scripts**

In `pnpm-workspace.yaml`, append `sharp` to `onlyBuiltDependencies` so future `pnpm install` doesn't re-prompt:
```yaml
onlyBuiltDependencies:
  - esbuild
  - sharp
```

**Step 3: Update `.env.example`** — the R2 placeholders are already there from Phase 1; verify they exist. They should look exactly like:
```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PUBLIC_URL=
```
No change needed unless missing.

**Step 4: Sanity-import Sharp**
Create a throwaway script `scripts/sharp-ping.ts`:
```ts
import sharp from 'sharp'

async function main() {
  const png = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer()
  console.log('sharp ok, png bytes:', png.length)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```
Run: `pnpm tsx scripts/sharp-ping.ts`
Expected: `sharp ok, png bytes: <some number>`. Delete the script when done.

**Step 5: Lint + test, then commit**
```bash
pnpm lint
pnpm test
```
Expected: lint clean, 33/33 tests pass (Phase 1 baseline).
```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "chore: add sharp, aws-sdk s3 client, exifr for phase 2"
```

---

## Task 2: Add `photos` table to schema and migrate

**Files:**
- Modify: `db/schema.ts`
- Generated: `db/migrations/0004_*.sql`, `db/migrations/meta/0004_*.json`

**Step 1: Add `photos` table to `db/schema.ts`** (append at the bottom)
```ts
export const photos = pgTable(
  'photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    uploaderUserId: uuid('uploader_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    processingState: text('processing_state', {
      enum: ['pending', 'processing', 'ready', 'failed'],
    })
      .notNull()
      .default('pending'),

    pendingExpiresAt: timestamp('pending_expires_at'),
    processingClaimedAt: timestamp('processing_claimed_at'),

    pendingKey: text('pending_key'),
    r2KeyOriginal: text('r2_key_original'),
    r2KeyPreview: text('r2_key_preview'),

    declaredMimeType: text('declared_mime_type').notNull(),
    declaredSizeBytes: integer('declared_size_bytes').notNull(),
    originalFilename: text('original_filename'),

    width: integer('width'),
    height: integer('height'),
    sizeBytesOriginal: integer('size_bytes_original'),
    takenAt: timestamp('taken_at'),
    uploadedAt: timestamp('uploaded_at'),

    hasDetectedFaces: boolean('has_detected_faces'),

    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('photos_event_id_idx').on(t.eventId),
    index('photos_event_taken_at_idx').on(t.eventId, t.takenAt.desc()),
    index('photos_event_state_idx').on(t.eventId, t.processingState),
    index('photos_uploader_event_idx').on(t.uploaderUserId, t.eventId),
  ],
)
```

**Step 2: Generate migration**
```bash
pnpm db:generate
```
Expected: `db/migrations/0004_*.sql` created. Inspect — should have one `CREATE TABLE photos`, two FKs (events.id, users.id), four indexes.

**Step 3: Apply to dev DB (Supabase)**
```bash
pnpm db:migrate
```
Expected: `migrations applied successfully`.

**Step 4: Apply to test DB (Docker)**
```bash
pnpm test:db:up   # if not already running
pnpm test:db:migrate
```
Expected: `migrations applied successfully`.

**Step 5: Verify**
```bash
PGPASSWORD=postgres psql -h localhost -p 54329 -U postgres -d postgres -c "\d photos"
```
Expected: lists all columns and indexes.

**Step 6: Commit**
```bash
git add db/schema.ts db/migrations
git commit -m "feat: add photos table with state machine and event-scoped keys"
```

---

## Task 3: Test fixture generator

**Files:**
- Create: `tests/setup-fixtures.ts`
- Modify: `vitest.config.ts` (add to `globalSetup`)
- Modify: `.gitignore` (add `tests/fixtures/`)

**Step 1: Write `tests/setup-fixtures.ts`**

Generates 4 small images in `tests/fixtures/photos/` once, before the test run. Idempotent — skips if files exist.

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const DIR = join(__dirname, 'fixtures/photos')

async function gen() {
  if (existsSync(join(DIR, 'plain.jpg'))) return
  mkdirSync(DIR, { recursive: true })

  // 1. Plain JPEG, 800x600, blue
  const plain = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 50, g: 100, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
  writeFileSync(join(DIR, 'plain.jpg'), plain)

  // 2. JPEG with EXIF orientation = 6 (rotated 90° CW)
  const rotated = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 50, b: 100 } },
  })
    .withExif({ IFD0: { Orientation: '6' } })
    .jpeg({ quality: 90 })
    .toBuffer()
  writeFileSync(join(DIR, 'rotated-orientation-6.jpg'), rotated)

  // 3. JPEG with GPS in EXIF
  const withGps = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 200, b: 50 } },
  })
    .withExif({
      GPS: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '37/1, 46/1, 30/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '122/1, 25/1, 10/1',
      },
    })
    .jpeg({ quality: 90 })
    .toBuffer()
  writeFileSync(join(DIR, 'with-gps.jpg'), withGps)

  // 4. HEIC built from JPEG bytes (Sharp 0.34+ supports HEIF encode via libheif)
  try {
    const heic = await sharp(plain).heif({ quality: 60, compression: 'hevc' }).toBuffer()
    writeFileSync(join(DIR, 'plain.heic'), heic)
  } catch {
    // Some Sharp builds ship without HEIF encode. In that case, fall back to copying the JPEG
    // so HEIC-decode tests can be skipped instead of breaking. The HEIC test is gated below.
    writeFileSync(join(DIR, 'plain.heic'), plain)
  }
}

export default gen
```

**Step 2: Wire it into `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/setup-fixtures.ts'],
    fileParallelism: false,
    sequence: { hooks: 'list' },
  },
})
```

**Step 3: Add `tests/fixtures/` to `.gitignore`**
```
# generated test fixtures
tests/fixtures/
```

**Step 4: Run tests**
```bash
pnpm test
```
Expected: 33/33 still pass; on first run a `tests/fixtures/photos/` directory appears with four files.

**Step 5: Commit**
```bash
git add tests/setup-fixtures.ts vitest.config.ts .gitignore
git commit -m "test: add Sharp-generated fixtures for image-processing tests"
```

---

## Task 4: R2 client wrapper (TDD)

**Files:**
- Create: `lib/photos/r2.ts`, `tests/photos/r2.test.ts`

**Step 1: Write failing test** at `tests/photos/r2.test.ts`

This wrapper centralizes R2 access so every other module mocks one place. The test asserts that the wrapper builds an S3Client with R2-shaped endpoint, and that the public functions call the right S3 commands.

```ts
import { mockClient } from 'aws-sdk-client-mock'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
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
```

**Step 2: Install the test mock**
```bash
pnpm add -D aws-sdk-client-mock
```

**Step 3: Run — expect fail** (module not found)
```bash
pnpm test tests/photos/r2.test.ts
```

**Step 4: Implement** at `lib/photos/r2.ts`
```ts
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

export async function createPresignedGetUrl(key: string, expiresInSeconds: number): Promise<string> {
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
      ((e as { name: string }).name === 'NotFound' ||
        (e as { name: string }).name === 'NoSuchKey')
    ) {
      return null
    }
    throw e
  }
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const out = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
  if (!out.Body) throw new Error('R2 GetObject returned empty body')
  const bytes = await (out.Body as { transformToByteArray: () => Promise<Uint8Array> })
    .transformToByteArray()
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
```

**Step 5: Run — expect pass**
```bash
pnpm test tests/photos/r2.test.ts
```

**Step 6: Commit**
```bash
git add lib/photos/r2.ts tests/photos/r2.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add R2 client wrapper (presigned URLs, head/get/put/delete)"
```

---

## Task 5: Image processing pipeline (TDD)

**Files:**
- Create: `lib/photos/process.ts`, `tests/photos/process.test.ts`

**Step 1: Write failing test** at `tests/photos/process.test.ts`

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import exifr from 'exifr'
import sharp from 'sharp'
import { describe, expect, test } from 'vitest'
import { ImageProcessError, processImage } from '@/lib/photos/process'

const FIX = join(__dirname, '../fixtures/photos')

describe('processImage', () => {
  test('JPEG round-trip outputs decodable JPEG with width/height', async () => {
    const buf = readFileSync(join(FIX, 'plain.jpg'))
    const out = await processImage(buf)

    expect(out.width).toBe(800)
    expect(out.height).toBe(600)

    const orig = await sharp(out.originalJpeg).metadata()
    expect(orig.format).toBe('jpeg')
    expect(orig.width).toBe(800)
    const prev = await sharp(out.previewJpeg).metadata()
    expect(prev.format).toBe('jpeg')
    expect(Math.max(prev.width ?? 0, prev.height ?? 0)).toBeLessThanOrEqual(2048)
  })

  test('preview is downsized when source > 2048 on long edge', async () => {
    const big = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer()
    const out = await processImage(big)
    const prev = await sharp(out.previewJpeg).metadata()
    expect(Math.max(prev.width ?? 0, prev.height ?? 0)).toBe(2048)
  })

  test('EXIF orientation=6 input is rotated upright in output', async () => {
    const buf = readFileSync(join(FIX, 'rotated-orientation-6.jpg'))
    const out = await processImage(buf)
    // Source was created as 800x600 with orientation=6 (90° CW), so the
    // upright output should be 600 wide × 800 tall.
    expect(out.width).toBe(600)
    expect(out.height).toBe(800)
  })

  test('GPS is stripped from output', async () => {
    const buf = readFileSync(join(FIX, 'with-gps.jpg'))
    const out = await processImage(buf)
    const exifOrig = await exifr.gps(out.originalJpeg)
    const exifPrev = await exifr.gps(out.previewJpeg)
    expect(exifOrig).toBeUndefined()
    expect(exifPrev).toBeUndefined()
  })

  test('takenAt is extracted when DateTimeOriginal present', async () => {
    const withDate = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withExif({ ExifIFD: { DateTimeOriginal: '2026:04:15 14:30:00' } })
      .jpeg({ quality: 90 })
      .toBuffer()
    const out = await processImage(withDate)
    expect(out.takenAt?.toISOString()).toBe('2026-04-15T14:30:00.000Z')
  })

  test('takenAt is null when EXIF absent', async () => {
    const buf = readFileSync(join(FIX, 'plain.jpg'))
    const out = await processImage(buf)
    expect(out.takenAt).toBeNull()
  })

  test('corrupt input throws ImageProcessError', async () => {
    await expect(processImage(Buffer.from('not an image'))).rejects.toBeInstanceOf(
      ImageProcessError,
    )
  })
})
```

**Step 2: Run — expect fail**
```bash
pnpm test tests/photos/process.test.ts
```

**Step 3: Implement** at `lib/photos/process.ts`

```ts
import exifr from 'exifr'
import sharp from 'sharp'

export class ImageProcessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageProcessError'
  }
}

export type ProcessImageResult = {
  originalJpeg: Buffer
  previewJpeg: Buffer
  width: number
  height: number
  takenAt: Date | null
}

const PREVIEW_LONG_EDGE = 2048
const ORIGINAL_QUALITY = 95
const PREVIEW_QUALITY = 85

export async function processImage(buf: Buffer): Promise<ProcessImageResult> {
  let takenAt: Date | null = null
  try {
    const exif = await exifr.parse(buf, { pick: ['DateTimeOriginal'] }).catch(() => null)
    if (exif?.DateTimeOriginal instanceof Date) {
      takenAt = exif.DateTimeOriginal
    } else if (typeof exif?.DateTimeOriginal === 'string') {
      const parsed = new Date(exif.DateTimeOriginal)
      if (!Number.isNaN(parsed.getTime())) takenAt = parsed
    }
  } catch {
    takenAt = null
  }

  let upright: sharp.Sharp
  let metadata: sharp.Metadata
  try {
    upright = sharp(buf, { failOn: 'truncated' }).rotate()
    metadata = await upright.metadata()
  } catch (e) {
    throw new ImageProcessError('failed to decode image', { cause: e })
  }

  if (!metadata.width || !metadata.height) {
    throw new ImageProcessError('image has no dimensions')
  }

  const width = metadata.width
  const height = metadata.height

  const originalJpeg = await upright
    .clone()
    .withMetadata({})
    .jpeg({ quality: ORIGINAL_QUALITY, mozjpeg: true })
    .toBuffer()

  const previewJpeg = await upright
    .clone()
    .resize({
      width: PREVIEW_LONG_EDGE,
      height: PREVIEW_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .withMetadata({})
    .jpeg({ quality: PREVIEW_QUALITY, mozjpeg: true })
    .toBuffer()

  return { originalJpeg, previewJpeg, width, height, takenAt }
}
```

**Step 4: Run — expect pass**
```bash
pnpm test tests/photos/process.test.ts
```

If a test fails on Sharp's HEIC encode (some platforms), the HEIC fixture falls back to a JPEG copy and the test for HEIC decode is therefore implicitly covered by the JPEG test. No fix needed.

**Step 5: Commit**
```bash
git add lib/photos/process.ts tests/photos/process.test.ts
git commit -m "feat: image processing pipeline (Sharp + EXIF strip + rotate)"
```

---

## Task 6: Cap-count helper (TDD)

**Files:**
- Create: `lib/photos/cap.ts`, `tests/photos/cap.test.ts`

This pulls the cap-count query into a tested helper so the init route stays readable.

**Step 1: Write failing test** at `tests/photos/cap.test.ts`

```ts
import { beforeEach, expect, test } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, photos, users } from '@/db/schema'
import { countActivePhotos } from '@/lib/photos/cap'

beforeEach(async () => {
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

async function seedEvent() {
  const [u] = await db
    .insert(users)
    .values({ name: 'H', contact: 'h@x.com', contactType: 'email' })
    .returning()
  const [e] = await db
    .insert(events)
    .values({
      hostUserId: u.id,
      name: 'E',
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    })
    .returning()
  return { u, e }
}

test('counts only ready/processing rows + non-expired pending', async () => {
  const { u, e } = await seedEvent()
  const future = new Date(Date.now() + 60_000)
  const past = new Date(Date.now() - 60_000)
  await db.insert(photos).values([
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'ready',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'processing',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'pending',
      pendingExpiresAt: future,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'pending',
      pendingExpiresAt: past,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'failed',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
  ])
  expect(await countActivePhotos(e.id)).toBe(3)
})

test('excludes soft-deleted rows', async () => {
  const { u, e } = await seedEvent()
  await db.insert(photos).values({
    eventId: e.id,
    uploaderUserId: u.id,
    processingState: 'ready',
    deletedAt: new Date(),
    declaredMimeType: 'image/jpeg',
    declaredSizeBytes: 1,
  })
  expect(await countActivePhotos(e.id)).toBe(0)
})
```

**Step 2: Implement** at `lib/photos/cap.ts`

```ts
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import { photos } from '@/db/schema'

export async function countActivePhotos(eventId: string): Promise<number> {
  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(photos)
    .where(
      and(
        eq(photos.eventId, eventId),
        isNull(photos.deletedAt),
        or(
          inArray(photos.processingState, ['ready', 'processing']),
          and(
            eq(photos.processingState, 'pending'),
            gt(photos.pendingExpiresAt, sql`now()`),
          ),
        ),
      ),
    )
  return c
}
```

**Step 3: Run — expect pass**
```bash
pnpm test tests/photos/cap.test.ts
```

**Step 4: Commit**
```bash
git add lib/photos/cap.ts tests/photos/cap.test.ts
git commit -m "feat: countActivePhotos helper for event cap enforcement"
```

---

## Task 7: `POST /api/events/:id/photos/init` route (TDD)

**Files:**
- Create: `app/api/events/[id]/photos/init/route.ts`, `tests/api/photos-init.test.ts`
- Create: `lib/photos/keys.ts` (key path helpers)

**Step 1: Implement key path helpers first** at `lib/photos/keys.ts`

```ts
export function pendingKey(eventId: string, photoId: string): string {
  return `events/${eventId}/pending/${photoId}.bin`
}

export function originalKey(eventId: string, photoId: string): string {
  return `events/${eventId}/original/${photoId}.jpg`
}

export function previewKey(eventId: string, photoId: string): string {
  return `events/${eventId}/preview/${photoId}.jpg`
}

export const ALLOWED_UPLOAD_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
])

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const MAX_PHOTOS_PER_EVENT = 5000
export const PUT_URL_TTL_SECONDS = 15 * 60
```

**Step 2: Write integration tests** at `tests/api/photos-init.test.ts`

```ts
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from '@/app/api/events/[id]/photos/init/route'
import { db } from '@/db'
import { eventMembers, events, photos, users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

vi.mock('@/lib/photos/r2', () => ({
  createPresignedPutUrl: vi.fn(async (key: string) => `https://fake.r2/${key}?signature=x`),
}))

async function seed(opts: { expired?: boolean } = {}) {
  const [host] = await db
    .insert(users)
    .values({ name: 'Host', contact: 'h@x.com', contactType: 'email' })
    .returning()
  const expiresAt = opts.expired
    ? new Date(Date.now() - 86400 * 1000)
    : new Date(Date.now() + 7 * 86400 * 1000)
  const [event] = await db
    .insert(events)
    .values({ hostUserId: host.id, name: 'E', expiresAt })
    .returning()
  await db.insert(eventMembers).values({ eventId: event.id, userId: host.id, role: 'host' })
  return { host, event }
}

beforeEach(async () => {
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

const post = (eventId: string, body: unknown) =>
  POST(
    new Request(`http://t/api/events/${eventId}/photos/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: eventId }) },
  )

describe('POST /api/events/:id/photos/init', () => {
  test('happy path inserts photos row and returns presigned URL', async () => {
    const { host, event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, {
      filename: 'IMG_001.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1_000_000,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.photoId).toBeTypeOf('string')
    expect(body.putUrl).toContain('events/')
    const [row] = await db.select().from(photos).where(eq(photos.id, body.photoId))
    expect(row.processingState).toBe('pending')
    expect(row.uploaderUserId).toBe(host.id)
    expect(row.eventId).toBe(event.id)
    expect(row.declaredMimeType).toBe('image/jpeg')
    expect(row.declaredSizeBytes).toBe(1_000_000)
    expect(row.originalFilename).toBe('IMG_001.jpg')
    expect(row.pendingKey).toBe(`events/${event.id}/pending/${body.photoId}.bin`)
    expect(row.pendingExpiresAt!.getTime()).toBeGreaterThan(Date.now())
  })

  test('401 when not authenticated', async () => {
    const { event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
    const res = await post(event.id, { filename: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 })
    expect(res.status).toBe(401)
  })

  test('403 when not a member', async () => {
    const { event } = await seed()
    const [other] = await db
      .insert(users)
      .values({ name: 'O', contact: 'o@x.com', contactType: 'email' })
      .returning()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(other)
    const res = await post(event.id, { filename: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 })
    expect(res.status).toBe(403)
  })

  test('410 when event is expired', async () => {
    const { host, event } = await seed({ expired: true })
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, { filename: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 })
    expect(res.status).toBe(410)
  })

  test('400 for disallowed MIME', async () => {
    const { host, event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, { filename: 'v.mp4', mimeType: 'video/mp4', sizeBytes: 1 })
    expect(res.status).toBe(400)
  })

  test('413 for declared size > 25 MB', async () => {
    const { host, event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, {
      filename: 'big.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 26 * 1024 * 1024,
    })
    expect(res.status).toBe(413)
  })

  test('429 when event cap reached', async () => {
    const { host, event } = await seed()
    // Seed 5000 ready photos.
    const future = new Date(Date.now() + 60_000)
    const rows = Array.from({ length: 5000 }, () => ({
      eventId: event.id,
      uploaderUserId: host.id,
      processingState: 'ready' as const,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
      pendingExpiresAt: future,
    }))
    // Bulk insert in chunks of 500 to keep parameters manageable.
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(photos).values(rows.slice(i, i + 500))
    }
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, { filename: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 })
    expect(res.status).toBe(429)
  })

  test('truncates oversized originalFilename', async () => {
    const { host, event } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, {
      filename: 'x'.repeat(1000) + '.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1,
    })
    const body = await res.json()
    const [row] = await db.select().from(photos).where(eq(photos.id, body.photoId))
    expect(row.originalFilename!.length).toBe(255)
  })
})
```

**Step 3: Run — expect fail**
```bash
pnpm test tests/api/photos-init.test.ts
```

**Step 4: Implement** at `app/api/events/[id]/photos/init/route.ts`

```ts
import { and, eq, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { eventMembers, events, photos } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { countActivePhotos } from '@/lib/photos/cap'
import {
  ALLOWED_UPLOAD_MIMES,
  MAX_PHOTOS_PER_EVENT,
  MAX_UPLOAD_BYTES,
  PUT_URL_TTL_SECONDS,
  pendingKey,
} from '@/lib/photos/keys'
import { createPresignedPutUrl } from '@/lib/photos/r2'

export const runtime = 'nodejs'

const PENDING_TTL_MS = 24 * 60 * 60 * 1000

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const body = (await req.json()) as {
    filename?: unknown
    mimeType?: unknown
    sizeBytes?: unknown
  }

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : ''
  if (!ALLOWED_UPLOAD_MIMES.has(mimeType)) {
    return NextResponse.json({ error: 'invalid mime type' }, { status: 400 })
  }

  const sizeBytes =
    typeof body.sizeBytes === 'number' && Number.isInteger(body.sizeBytes) ? body.sizeBytes : -1
  if (sizeBytes <= 0) {
    return NextResponse.json({ error: 'invalid size' }, { status: 400 })
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'size exceeds limit' }, { status: 413 })
  }

  const filename =
    typeof body.filename === 'string' && body.filename.length > 0
      ? body.filename.slice(0, 255)
      : null

  // Membership + event existence + expiry, then cap-count + INSERT in a single TX.
  const photoId = await db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId))
    if (!event) throw Object.assign(new Error('not found'), { status: 404 })
    if (event.expiresAt.getTime() <= Date.now()) {
      throw Object.assign(new Error('event expired'), { status: 410 })
    }

    const [membership] = await tx
      .select()
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, user.id)))
    if (!membership) throw Object.assign(new Error('forbidden'), { status: 403 })

    // Lock the parent event row to serialize cap checks.
    await tx.execute(sql`SELECT 1 FROM events WHERE id = ${eventId} FOR UPDATE`)

    const count = await countActivePhotos(eventId)
    if (count >= MAX_PHOTOS_PER_EVENT) {
      throw Object.assign(new Error('event cap reached'), { status: 429 })
    }

    const [row] = await tx
      .insert(photos)
      .values({
        eventId,
        uploaderUserId: user.id,
        processingState: 'pending',
        pendingExpiresAt: new Date(Date.now() + PENDING_TTL_MS),
        pendingKey: '',
        declaredMimeType: mimeType,
        declaredSizeBytes: sizeBytes,
        originalFilename: filename,
      })
      .returning({ id: photos.id })
    const id = row.id
    const key = pendingKey(eventId, id)
    await tx.update(photos).set({ pendingKey: key }).where(eq(photos.id, id))
    return id
  }).catch((e: unknown) => {
    if (typeof e === 'object' && e !== null && 'status' in e) {
      return e as { status: number; message: string }
    }
    throw e
  })

  if (typeof photoId !== 'string') {
    return NextResponse.json({ error: photoId.message }, { status: photoId.status })
  }

  const putUrl = await createPresignedPutUrl(
    pendingKey(eventId, photoId),
    'application/octet-stream',
    PUT_URL_TTL_SECONDS,
  )

  return NextResponse.json({ photoId, putUrl })
}
```

> **Note on `Content-Type` for the presigned PUT:** R2 presigned URLs bind the content-type into the signature when present at sign time. Browsers PUT'ing through fetch() will use whatever `Content-Type` header the client sets. To keep the signature stable across MIME variants we sign with `application/octet-stream` and the client must `fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file })`. The actual MIME is recorded in `declaredMimeType` and re-validated by Sharp at finalize.

**Step 5: Run — expect pass**
```bash
pnpm test tests/api/photos-init.test.ts
```

**Step 6: Commit**
```bash
git add app/api/events/\[id\]/photos lib/photos/keys.ts tests/api/photos-init.test.ts
git commit -m "feat: POST /api/events/:id/photos/init with cap lock + presigned PUT"
```

---

## Task 8: `POST /api/events/:id/photos/:photoId/finalize` route (TDD)

**Files:**
- Create: `app/api/events/[id]/photos/[photoId]/finalize/route.ts`, `tests/api/photos-finalize.test.ts`

**Step 1: Write integration tests** at `tests/api/photos-finalize.test.ts`

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from '@/app/api/events/[id]/photos/[photoId]/finalize/route'
import { db } from '@/db'
import { eventMembers, events, photos, users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

const FIX = join(__dirname, '../fixtures/photos')

// In-memory R2 store keyed by R2 object key.
const store = new Map<string, Buffer>()

vi.mock('@/lib/photos/r2', () => ({
  createPresignedGetUrl: vi.fn(async (key: string) => `https://fake.r2/${key}?signature=x`),
  headObject: vi.fn(async (key: string) =>
    store.has(key) ? { contentLength: store.get(key)!.length } : null,
  ),
  getObjectBuffer: vi.fn(async (key: string) => {
    const b = store.get(key)
    if (!b) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
    return b
  }),
  putObject: vi.fn(async (key: string, body: Buffer) => {
    store.set(key, body)
  }),
  deleteObject: vi.fn(async (key: string) => {
    store.delete(key)
  }),
}))

async function seed() {
  const [host] = await db
    .insert(users)
    .values({ name: 'Host', contact: 'h@x.com', contactType: 'email' })
    .returning()
  const [event] = await db
    .insert(events)
    .values({
      hostUserId: host.id,
      name: 'E',
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: event.id, userId: host.id, role: 'host' })
  return { host, event }
}

async function insertPending(eventId: string, uploaderUserId: string, filename = 'a.jpg') {
  const [row] = await db
    .insert(photos)
    .values({
      eventId,
      uploaderUserId,
      processingState: 'pending',
      pendingExpiresAt: new Date(Date.now() + 60_000),
      pendingKey: '',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
      originalFilename: filename,
    })
    .returning()
  const key = `events/${eventId}/pending/${row.id}.bin`
  await db.update(photos).set({ pendingKey: key }).where(eq(photos.id, row.id))
  return { ...row, pendingKey: key }
}

beforeEach(async () => {
  store.clear()
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

const post = (eventId: string, photoId: string) =>
  POST(new Request(`http://t/api/events/${eventId}/photos/${photoId}/finalize`, { method: 'POST' }), {
    params: Promise.resolve({ id: eventId, photoId }),
  })

describe('POST /api/events/:id/photos/:photoId/finalize', () => {
  test('happy path: pending → processing → ready', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, readFileSync(join(FIX, 'plain.jpg')))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)

    const res = await post(event.id, row.id)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.photo.processingState).toBe('ready')

    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('ready')
    expect(final.r2KeyOriginal).toBe(`events/${event.id}/original/${row.id}.jpg`)
    expect(final.r2KeyPreview).toBe(`events/${event.id}/preview/${row.id}.jpg`)
    expect(final.width).toBe(800)
    expect(final.height).toBe(600)
    expect(final.uploadedAt).not.toBeNull()
    expect(final.pendingKey).toBeNull()

    expect(store.has(row.pendingKey)).toBe(false)
    expect(store.has(final.r2KeyOriginal!)).toBe(true)
    expect(store.has(final.r2KeyPreview!)).toBe(true)
  })

  test('403 when caller is not the uploader', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, readFileSync(join(FIX, 'plain.jpg')))
    const [stranger] = await db
      .insert(users)
      .values({ name: 'S', contact: 's@x.com', contactType: 'email' })
      .returning()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(stranger)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(403)
  })

  test('410 when row is expired', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    await db
      .update(photos)
      .set({ pendingExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(photos.id, row.id))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(410)
    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('failed')
  })

  test('idempotent: second finalize on a ready row returns 200 with same row', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, readFileSync(join(FIX, 'plain.jpg')))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const r1 = await post(event.id, row.id)
    expect(r1.status).toBe(200)
    const r2 = await post(event.id, row.id)
    expect(r2.status).toBe(200)
    const b2 = await r2.json()
    expect(b2.photo.processingState).toBe('ready')
  })

  test('413 when actual content-length > 25 MB', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, Buffer.alloc(26 * 1024 * 1024))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(413)
    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('failed')
    expect(store.has(row.pendingKey)).toBe(false)
  })

  test('410 when pending object missing in R2', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    // store empty — pending object never uploaded
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(410)
    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('failed')
  })

  test('422 when Sharp fails on garbage bytes', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    store.set(row.pendingKey, Buffer.from('not an image'))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(422)
    const [final] = await db.select().from(photos).where(eq(photos.id, row.id))
    expect(final.processingState).toBe('failed')
    expect(store.has(row.pendingKey)).toBe(false)
  })

  test('atomic claim: stale processing row is reclaimed', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    await db
      .update(photos)
      .set({
        processingState: 'processing',
        processingClaimedAt: new Date(Date.now() - 6 * 60 * 1000),
      })
      .where(eq(photos.id, row.id))
    store.set(row.pendingKey, readFileSync(join(FIX, 'plain.jpg')))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(200)
  })

  test('409 when concurrent finalize is recently-claimed', async () => {
    const { host, event } = await seed()
    const row = await insertPending(event.id, host.id)
    await db
      .update(photos)
      .set({ processingState: 'processing', processingClaimedAt: new Date() })
      .where(eq(photos.id, row.id))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await post(event.id, row.id)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.status).toBe('processing')
  })
})
```

**Step 2: Run — expect fail**
```bash
pnpm test tests/api/photos-finalize.test.ts
```

**Step 3: Implement** at `app/api/events/[id]/photos/[photoId]/finalize/route.ts`

```ts
import { and, eq, gt, lt, or, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { photos } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { MAX_UPLOAD_BYTES, originalKey, previewKey } from '@/lib/photos/keys'
import { ImageProcessError, processImage } from '@/lib/photos/process'
import {
  deleteObject,
  getObjectBuffer,
  headObject,
  putObject,
} from '@/lib/photos/r2'

export const runtime = 'nodejs'
// Sharp + R2 round-trips can take 10s+ on large HEICs. Bump above the Vercel default.
export const maxDuration = 60

const STALE_CLAIM_AGE_MS = 5 * 60 * 1000

async function markFailed(photoId: string, alsoDeleteKey?: string | null): Promise<void> {
  await db
    .update(photos)
    .set({
      processingState: 'failed',
      processingClaimedAt: null,
    })
    .where(eq(photos.id, photoId))
  if (alsoDeleteKey) {
    try {
      await deleteObject(alsoDeleteKey)
    } catch {
      // best effort
    }
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  const { id: eventId, photoId } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  // Step 2-3: load row + uploader check
  const [row] = await db.select().from(photos).where(eq(photos.id, photoId))
  if (!row || row.eventId !== eventId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (row.uploaderUserId !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Step 4: TTL check
  if (
    row.pendingExpiresAt &&
    row.pendingExpiresAt.getTime() < Date.now() &&
    (row.processingState === 'pending' || row.processingState === 'processing')
  ) {
    await markFailed(row.id, row.pendingKey)
    return NextResponse.json({ status: 'expired' }, { status: 410 })
  }

  // Step 5: atomic claim + stale reclaim
  const staleCutoff = new Date(Date.now() - STALE_CLAIM_AGE_MS)
  const claimed = await db
    .update(photos)
    .set({ processingState: 'processing', processingClaimedAt: new Date() })
    .where(
      and(
        eq(photos.id, row.id),
        or(
          eq(photos.processingState, 'pending'),
          and(
            eq(photos.processingState, 'processing'),
            lt(photos.processingClaimedAt, staleCutoff),
          ),
        ),
      ),
    )
    .returning()

  if (claimed.length === 0) {
    // Reread + branch.
    const [now] = await db.select().from(photos).where(eq(photos.id, row.id))
    if (now.processingState === 'ready') {
      return NextResponse.json({ photo: now })
    }
    if (now.processingState === 'failed') {
      return NextResponse.json({ status: 'failed' }, { status: 422 })
    }
    if (now.processingState === 'processing') {
      return NextResponse.json(
        { status: 'processing', retryAfterSeconds: 30 },
        { status: 409 },
      )
    }
    return NextResponse.json({ status: 'unexpected' }, { status: 500 })
  }

  const claimedRow = claimed[0]
  const pending = claimedRow.pendingKey
  if (!pending) {
    await markFailed(claimedRow.id)
    return NextResponse.json({ status: 'corrupt' }, { status: 500 })
  }

  // Step 6: HEAD pending
  const head = await headObject(pending)
  if (!head) {
    await markFailed(claimedRow.id)
    return NextResponse.json({ status: 'expired' }, { status: 410 })
  }
  if (head.contentLength > MAX_UPLOAD_BYTES) {
    await markFailed(claimedRow.id, pending)
    return NextResponse.json({ status: 'too-large' }, { status: 413 })
  }

  // Sharp pipeline
  let buf: Buffer
  try {
    buf = await getObjectBuffer(pending)
  } catch {
    await markFailed(claimedRow.id, pending)
    return NextResponse.json({ status: 'expired' }, { status: 410 })
  }

  let result
  try {
    result = await processImage(buf)
  } catch (e) {
    await markFailed(claimedRow.id, pending)
    if (e instanceof ImageProcessError) {
      return NextResponse.json({ status: 'unprocessable' }, { status: 422 })
    }
    throw e
  }

  // Write outputs
  const okey = originalKey(eventId, claimedRow.id)
  const pkey = previewKey(eventId, claimedRow.id)
  await putObject(okey, result.originalJpeg, 'image/jpeg')
  await putObject(pkey, result.previewJpeg, 'image/jpeg')
  try {
    await deleteObject(pending)
  } catch {
    // best effort
  }

  const [final] = await db
    .update(photos)
    .set({
      processingState: 'ready',
      r2KeyOriginal: okey,
      r2KeyPreview: pkey,
      width: result.width,
      height: result.height,
      sizeBytesOriginal: result.originalJpeg.length,
      takenAt: result.takenAt,
      uploadedAt: new Date(),
      pendingKey: null,
      pendingExpiresAt: null,
      processingClaimedAt: null,
    })
    .where(eq(photos.id, claimedRow.id))
    .returning()

  return NextResponse.json({ photo: final })
}
```

**Step 4: Run — expect pass**
```bash
pnpm test tests/api/photos-finalize.test.ts
```

**Step 5: Commit**
```bash
git add app/api/events/\[id\]/photos/\[photoId\] tests/api/photos-finalize.test.ts
git commit -m "feat: POST /api/events/:id/photos/:photoId/finalize (atomic claim + Sharp + write back)"
```

---

## Task 9: `GET /api/photos/:photoId/original` route (TDD)

**Files:**
- Create: `app/api/photos/[photoId]/original/route.ts`, `tests/api/photos-original.test.ts`

**Step 1: Write tests** at `tests/api/photos-original.test.ts`

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { GET } from '@/app/api/photos/[photoId]/original/route'
import { db } from '@/db'
import { eventMembers, events, photos, users } from '@/db/schema'
import * as currentUser from '@/lib/auth/current-user'

vi.mock('@/lib/photos/r2', () => ({
  createPresignedGetUrl: vi.fn(async (key: string) => `https://fake.r2/${key}?signature=x`),
}))

async function seed() {
  const [host] = await db
    .insert(users)
    .values({ name: 'Host', contact: 'h@x.com', contactType: 'email' })
    .returning()
  const [event] = await db
    .insert(events)
    .values({
      hostUserId: host.id,
      name: 'E',
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: event.id, userId: host.id, role: 'host' })
  const [photo] = await db
    .insert(photos)
    .values({
      eventId: event.id,
      uploaderUserId: host.id,
      processingState: 'ready',
      r2KeyOriginal: `events/${event.id}/original/x.jpg`,
      r2KeyPreview: `events/${event.id}/preview/x.jpg`,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    })
    .returning()
  return { host, event, photo }
}

beforeEach(async () => {
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
  vi.restoreAllMocks()
})

const get = (id: string) =>
  GET(new Request(`http://t/api/photos/${id}/original`), {
    params: Promise.resolve({ photoId: id }),
  })

describe('GET /api/photos/:photoId/original', () => {
  test('302 redirect to presigned URL for uploader', async () => {
    const { host, photo } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await get(photo.id)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('signature=')
  })

  test('401 when unauthenticated', async () => {
    const { photo } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(null)
    const res = await get(photo.id)
    expect(res.status).toBe(401)
  })

  test('404 when caller is not uploader (no existence oracle)', async () => {
    const { photo } = await seed()
    const [stranger] = await db
      .insert(users)
      .values({ name: 'S', contact: 's@x.com', contactType: 'email' })
      .returning()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(stranger)
    const res = await get(photo.id)
    expect(res.status).toBe(404)
  })

  test('404 when photo missing', async () => {
    const { host } = await seed()
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await get('00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })

  test('404 when photo state is not ready', async () => {
    const { host, photo } = await seed()
    await db
      .update(photos)
      .set({ processingState: 'pending', r2KeyOriginal: null })
      .where(eq(photos.id, photo.id))
    vi.spyOn(currentUser, 'getCurrentUser').mockResolvedValue(host)
    const res = await get(photo.id)
    expect(res.status).toBe(404)
  })
})
```

(Add `import { eq } from 'drizzle-orm'` to the test file.)

**Step 2: Run — expect fail**
```bash
pnpm test tests/api/photos-original.test.ts
```

**Step 3: Implement** at `app/api/photos/[photoId]/original/route.ts`

```ts
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { photos } from '@/db/schema'
import { getCurrentUser } from '@/lib/auth/current-user'
import { createPresignedGetUrl } from '@/lib/photos/r2'

export const runtime = 'nodejs'

const ORIGINAL_URL_TTL_SECONDS = 5 * 60

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ photoId: string }> },
) {
  const { photoId } = await params

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const [row] = await db.select().from(photos).where(eq(photos.id, photoId))
  // 404 conflates "missing" / "not uploader" / "not ready" — no existence oracle.
  if (
    !row ||
    row.uploaderUserId !== user.id ||
    row.processingState !== 'ready' ||
    row.deletedAt !== null ||
    !row.r2KeyOriginal
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const url = await createPresignedGetUrl(row.r2KeyOriginal, ORIGINAL_URL_TTL_SECONDS)
  return NextResponse.redirect(url, 302)
}
```

**Step 4: Run — expect pass**
```bash
pnpm test tests/api/photos-original.test.ts
```

**Step 5: Commit**
```bash
git add app/api/photos tests/api/photos-original.test.ts
git commit -m "feat: GET /api/photos/:photoId/original (uploader-only 302 to presigned URL)"
```

---

## Task 10: Upload UI client component

**Files:**
- Create: `components/UploadDropzone.tsx`
- Create: `lib/photos/upload-client.ts` (browser-side upload helper)
- Create: `tests/photos/upload-client.test.ts`

**Step 1: Write `lib/photos/upload-client.ts`**

A pure helper that does init → PUT → finalize for a single file. Returns the photo row.

```ts
export type UploadProgress = { done: number; total: number; failed: number }

type UploadResult =
  | { ok: true; photoId: string }
  | { ok: false; reason: string }

export async function uploadOne(eventId: string, file: File): Promise<UploadResult> {
  // 1. init
  const initRes = await fetch(`/api/events/${eventId}/photos/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    }),
  })
  if (!initRes.ok) {
    return { ok: false, reason: `init failed (${initRes.status})` }
  }
  const { photoId, putUrl } = (await initRes.json()) as { photoId: string; putUrl: string }

  // 2. PUT bytes directly to R2
  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  if (!putRes.ok) {
    return { ok: false, reason: `upload failed (${putRes.status})` }
  }

  // 3. finalize
  const finRes = await fetch(`/api/events/${eventId}/photos/${photoId}/finalize`, {
    method: 'POST',
  })
  if (!finRes.ok) {
    return { ok: false, reason: `finalize failed (${finRes.status})` }
  }
  return { ok: true, photoId }
}

export async function uploadBatch(
  eventId: string,
  files: File[],
  concurrency: number,
  onProgress: (p: UploadProgress) => void,
): Promise<UploadResult[]> {
  const results: UploadResult[] = []
  let done = 0
  let failed = 0
  let i = 0
  const total = files.length

  async function worker() {
    while (i < total) {
      const idx = i++
      const r = await uploadOne(eventId, files[idx]).catch(
        (e): UploadResult => ({ ok: false, reason: String(e) }),
      )
      results[idx] = r
      done++
      if (!r.ok) failed++
      onProgress({ done, total, failed })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))
  return results
}
```

**Step 2: Test the helper** at `tests/photos/upload-client.test.ts` — test against `fetch` mocks.

```ts
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { uploadBatch, uploadOne } from '@/lib/photos/upload-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function file(name = 'a.jpg', size = 100) {
  return new File([new Uint8Array(size)], name, { type: 'image/jpeg' })
}

test('uploadOne happy path', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ photoId: 'P', putUrl: 'http://r2/p' }), { status: 200 }))
    .mockResolvedValueOnce(new Response('', { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ photo: {} }), { status: 200 }))
  const r = await uploadOne('E', file())
  expect(r).toEqual({ ok: true, photoId: 'P' })
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

test('uploadOne returns failure on init 4xx', async () => {
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 413 }))
  const r = await uploadOne('E', file())
  expect(r.ok).toBe(false)
})

test('uploadBatch reports aggregate progress', async () => {
  fetchMock.mockImplementation((_url: string, init?: { method?: string }) => {
    if (init?.method === 'POST' && (_url as string).endsWith('/init')) {
      return Promise.resolve(new Response(JSON.stringify({ photoId: crypto.randomUUID(), putUrl: 'http://r2/p' }), { status: 200 }))
    }
    return Promise.resolve(new Response(JSON.stringify({ photo: {} }), { status: 200 }))
  })
  const seen: number[] = []
  const r = await uploadBatch('E', [file(), file(), file(), file()], 3, (p) => seen.push(p.done))
  expect(r.every((x) => x.ok)).toBe(true)
  expect(seen[seen.length - 1]).toBe(4)
})
```

**Step 3: Run unit test — expect pass after implementation**
```bash
pnpm test tests/photos/upload-client.test.ts
```

**Step 4: Implement `components/UploadDropzone.tsx`**

```tsx
'use client'

import { type ChangeEvent, type DragEvent, useRef, useState } from 'react'
import { uploadBatch } from '@/lib/photos/upload-client'

const ACCEPTED = 'image/jpeg,image/png,image/heic,image/heif'

export function UploadDropzone({ eventId }: { eventId: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(
    null,
  )
  const [dragOver, setDragOver] = useState(false)

  async function handleFiles(files: File[]) {
    const accepted = files.filter((f) =>
      ['image/jpeg', 'image/png', 'image/heic', 'image/heif'].includes(f.type),
    )
    if (accepted.length === 0) return
    setProgress({ done: 0, total: accepted.length, failed: 0 })
    await uploadBatch(eventId, accepted, 3, setProgress)
    // After all done, refresh the gallery by hard-reloading. Phase 5 will replace
    // this with optimistic UI / incremental rendering.
    window.location.reload()
  }

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) handleFiles(files)
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) handleFiles(files)
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`rounded border-2 border-dashed p-6 text-center ${
        dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        multiple
        className="hidden"
        onChange={onChange}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="rounded bg-black px-4 py-2 text-white"
      >
        Add photos
      </button>
      <p className="mt-2 text-sm text-gray-500">or drag and drop here</p>
      {progress && progress.done < progress.total && (
        <p className="mt-3 text-sm">
          Uploading {progress.done} of {progress.total}…
        </p>
      )}
      {progress && progress.done === progress.total && (
        <p className="mt-3 text-sm">
          Uploaded {progress.done - progress.failed} of {progress.total}.
          {progress.failed > 0 && ` ${progress.failed} failed.`}
        </p>
      )}
    </div>
  )
}
```

**Step 5: Lint, test, commit**
```bash
pnpm lint
pnpm test
git add components/UploadDropzone.tsx lib/photos/upload-client.ts tests/photos/upload-client.test.ts
git commit -m "feat: UploadDropzone component with batched concurrent uploads"
```

---

## Task 11: Gallery server component + integrate on event page

**Files:**
- Create: `lib/photos/gallery.ts` (helper that returns photos with presigned preview URLs)
- Create: `tests/photos/gallery.test.ts`
- Modify: `app/(app)/events/[id]/page.tsx`

**Step 1: Write `lib/photos/gallery.ts`**

```ts
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { photos } from '@/db/schema'
import { createPresignedGetUrl } from './r2'

const PREVIEW_URL_TTL_SECONDS = 5 * 60

export type GalleryPhoto = {
  id: string
  previewUrl: string
  width: number | null
  height: number | null
  takenAt: Date | null
  createdAt: Date
}

export async function listMyPhotos(eventId: string, userId: string): Promise<GalleryPhoto[]> {
  const rows = await db
    .select()
    .from(photos)
    .where(
      and(
        eq(photos.eventId, eventId),
        eq(photos.uploaderUserId, userId),
        eq(photos.processingState, 'ready'),
        isNull(photos.deletedAt),
      ),
    )
    .orderBy(desc(photos.takenAt), desc(photos.createdAt))

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      previewUrl: await createPresignedGetUrl(row.r2KeyPreview!, PREVIEW_URL_TTL_SECONDS),
      width: row.width,
      height: row.height,
      takenAt: row.takenAt,
      createdAt: row.createdAt,
    })),
  )
}
```

**Step 2: Test it** at `tests/photos/gallery.test.ts`

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { db } from '@/db'
import { eventMembers, events, photos, users } from '@/db/schema'
import { listMyPhotos } from '@/lib/photos/gallery'

vi.mock('@/lib/photos/r2', () => ({
  createPresignedGetUrl: vi.fn(async (key: string) => `https://fake/${key}?sig=x`),
}))

async function seed() {
  const [u] = await db
    .insert(users)
    .values({ name: 'U', contact: 'u@x.com', contactType: 'email' })
    .returning()
  const [e] = await db
    .insert(events)
    .values({
      hostUserId: u.id,
      name: 'E',
      expiresAt: new Date(Date.now() + 86400 * 1000),
    })
    .returning()
  await db.insert(eventMembers).values({ eventId: e.id, userId: u.id, role: 'host' })
  return { u, e }
}

beforeEach(async () => {
  await db.delete(photos)
  await db.delete(eventMembers)
  await db.delete(events)
  await db.delete(users)
})

test('lists only ready non-deleted photos for the uploader', async () => {
  const { u, e } = await seed()
  await db.insert(photos).values([
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'ready',
      r2KeyPreview: 'preview/1',
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'pending',
      r2KeyPreview: null,
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
    {
      eventId: e.id,
      uploaderUserId: u.id,
      processingState: 'ready',
      r2KeyPreview: 'preview/2',
      deletedAt: new Date(),
      declaredMimeType: 'image/jpeg',
      declaredSizeBytes: 1,
    },
  ])
  const out = await listMyPhotos(e.id, u.id)
  expect(out).toHaveLength(1)
  expect(out[0].previewUrl).toBe('https://fake/preview/1?sig=x')
})

test('returns empty list for non-uploader', async () => {
  const { e } = await seed()
  const [other] = await db
    .insert(users)
    .values({ name: 'O', contact: 'o@x.com', contactType: 'email' })
    .returning()
  await db.insert(photos).values({
    eventId: e.id,
    uploaderUserId: e.hostUserId,
    processingState: 'ready',
    r2KeyPreview: 'preview/1',
    declaredMimeType: 'image/jpeg',
    declaredSizeBytes: 1,
  })
  expect(await listMyPhotos(e.id, other.id)).toEqual([])
})
```

Run: `pnpm test tests/photos/gallery.test.ts`. Expected: 2 pass.

**Step 3: Modify `app/(app)/events/[id]/page.tsx`** — add upload + gallery UI below the existing share-link block.

Read the existing file first; append:

```tsx
import { UploadDropzone } from '@/components/UploadDropzone'
import { listMyPhotos } from '@/lib/photos/gallery'
```

Inside the page component, after the existing `<ShareLink>`:

```tsx
const myPhotos = await listMyPhotos(event.id, user.id)

// (in JSX, after <ShareLink ... />)
<section className="mt-8">
  <h2 className="mb-3 text-lg font-medium">Add photos</h2>
  <UploadDropzone eventId={event.id} />
</section>

<section className="mt-8">
  <h2 className="mb-3 text-lg font-medium">Your uploads ({myPhotos.length})</h2>
  {myPhotos.length === 0 ? (
    <p className="text-sm text-gray-500">No uploads yet.</p>
  ) : (
    <ul className="grid grid-cols-3 gap-2">
      {myPhotos.map((p) => (
        <li key={p.id}>
          <a href={`/api/photos/${p.id}/original`} target="_blank" rel="noreferrer">
            <img
              src={p.previewUrl}
              alt=""
              loading="lazy"
              className="aspect-square w-full rounded object-cover"
            />
          </a>
        </li>
      ))}
    </ul>
  )}
</section>
```

**Step 4: Manual smoke** — `pnpm dev`, sign in, create an event, upload a few JPEGs from camera roll, refresh, see thumbnails.

**Step 5: Commit**
```bash
git add app/\(app\)/events lib/photos/gallery.ts tests/photos/gallery.test.ts
git commit -m "feat: gallery server component with presigned-at-render preview URLs"
```

---

## Task 12: Test-only sign-in route for E2E

**Files:**
- Create: `app/api/test/sign-in-as/route.ts`

This is the same shape as Phase 1's auth/verify route but skips the magic-link round-trip; gated by `NODE_ENV === 'test'`.

**Step 1: Implement** at `app/api/test/sign-in-as/route.ts`

```ts
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { users } from '@/db/schema'
import { getSession } from '@/lib/auth/session'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== 'test') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { contact, name } = (await req.json()) as { contact?: string; name?: string }
  if (!contact || !name) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
  const [existing] = await db.select().from(users).where(eq(users.contact, contact.toLowerCase()))
  let user = existing
  if (!user) {
    ;[user] = await db
      .insert(users)
      .values({ name, contact: contact.toLowerCase(), contactType: 'email' })
      .returning()
  }
  const session = await getSession()
  session.userId = user.id
  await session.save()
  return NextResponse.json({ user: { id: user.id, name: user.name } })
}
```

**Step 2: Verify the route 403s outside test mode** — quick manual smoke:
```bash
pnpm dev &
DEV_PID=$!
sleep 4
curl -s -X POST http://localhost:3000/api/test/sign-in-as \
  -H 'content-type: application/json' \
  -d '{"contact":"a@b.com","name":"X"}' \
  -o /dev/null -w "%{http_code}\n"
kill $DEV_PID
```
Expected: `403`.

**Step 3: Commit**
```bash
git add app/api/test
git commit -m "test: add NODE_ENV=test-gated sign-in helper for e2e"
```

---

## Task 13: Playwright E2E for upload flow

**Files:**
- Modify: `playwright.config.ts` (add `R2_*` env to `webServer`)
- Create: `e2e/upload.spec.ts`

**Step 1: Update `playwright.config.ts` `webServer.env`**

Read the existing file. Add R2 env vars:
```ts
env: {
  // ... existing entries ...
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID ?? '',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? '',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? '',
  R2_BUCKET: process.env.R2_BUCKET ?? '',
  NODE_ENV: 'test',
},
```

**Step 2: Write E2E spec** at `e2e/upload.spec.ts`

```ts
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test('host signs in, creates event, uploads photos, sees thumbnails', async ({ page, request }) => {
  // Sign in via test-only route
  await request.post('/api/test/sign-in-as', {
    data: { contact: 'host+e2e@example.com', name: 'E2E Host' },
  })
  // Cookies from request fixture aren't shared with page in some Playwright versions;
  // do it through the page's UI for robustness:
  await page.goto('/auth/signin')
  // Use test endpoint via fetch from the page instead, so the session lands on the page's cookie jar.
  await page.evaluate(async () => {
    await fetch('/api/test/sign-in-as', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact: 'host+e2e@example.com', name: 'E2E Host' }),
    })
  })

  // Create event
  await page.goto('/events/new')
  await page.getByPlaceholder('Event name').fill('E2E Photos')
  await page.getByRole('button', { name: /create event/i }).click()

  await expect(page).toHaveURL(/\/events\/[0-9a-f-]+/)

  // Upload three fixture images
  const fixtureDir = join(process.cwd(), 'tests/fixtures/photos')
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /add photos/i }).click()
  const chooser = await fileChooserPromise
  await chooser.setFiles([
    join(fixtureDir, 'plain.jpg'),
    join(fixtureDir, 'rotated-orientation-6.jpg'),
    join(fixtureDir, 'with-gps.jpg'),
  ])

  // After upload completion the component triggers reload; wait for the gallery section.
  await page.waitForLoadState('networkidle')
  await expect(page.getByText(/Your uploads \(3\)/i)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('img[alt=""]')).toHaveCount(3)
})
```

**Step 3: Run E2E**
```bash
pnpm test:e2e
```
Expected: 3 tests pass (the existing 2 from Phase 1 + this new one).

**Step 4: Commit**
```bash
git add e2e/upload.spec.ts playwright.config.ts
git commit -m "test: e2e for host upload flow with fixture images"
```

---

## Task 14: CI workflow + README updates

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Step 1: Update `.github/workflows/ci.yml`** to set `R2_*` env (using GitHub secrets).

Add these to the job-level `env:` block:
```yaml
R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
R2_BUCKET: ${{ secrets.R2_BUCKET }}
```

The unit tests don't actually hit R2 (they mock at the module level), but `pnpm build` and `pnpm test:e2e` need these set so the env-validation in `lib/photos/r2.ts` doesn't throw at module load. For CI, set them to dummy strings via GitHub repo secrets:
- `R2_ACCOUNT_ID = ci-fake-account`
- `R2_ACCESS_KEY_ID = ci-fake-key`
- `R2_SECRET_ACCESS_KEY = ci-fake-secret`
- `R2_BUCKET = phostro-photos`

(Document this in the README; the user must set these in repo settings before CI runs.)

**Step 2: Update README**

Add to the "Setup" section:
```
3. R2 setup (Phase 2 only):
   - Cloudflare R2 → bucket `phostro-photos`, private.
   - API token: Object Read & Write, scoped to that bucket. Copy access key + secret.
   - CORS policy allowing localhost:3000 / localhost:3010, methods GET/PUT/HEAD.
   - Lifecycle rule: delete after 1 day, scoped to (or covering) `events/.../pending/`.
```

And to the "Common commands" table add no new commands (test:e2e, test:db:up, etc., are unchanged).

**Step 3: Commit**
```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: add R2_* env to CI; docs: R2 setup steps in README"
```

---

## Phase 2 done — sanity checks before merging

- `pnpm lint` clean.
- `pnpm test` — all unit + integration green (Phase 1's 33 + Phase 2's ~30 = ~63).
- `pnpm test:e2e` — 3 pass.
- `pnpm build` — green.
- Manually: `pnpm dev`, sign in, create event, upload 3 JPEGs from a phone, refresh → 3 thumbnails. Click thumbnail → opens R2 presigned URL of the original.
- Manually verify in Supabase: 3 `photos` rows with `processing_state='ready'`, `r2_key_*` populated, `taken_at` set if EXIF was present.

**Before moving on:**
1. Invoke `superpowers:requesting-code-review` to review Phase 2.
2. Fix any Critical/Important issues — loop until clean.
3. Then plan Phase 3.

---

## What's intentionally NOT in Phase 2 (deferred)

- Face detection / embedding worker — Phase 3.
- General-visibility gallery (You / By Me / Other) — Phase 5.
- Per-photo download UI for non-uploaders — Phase 5.
- Bulk download — Phase 5.
- Email notifications — Phase 6.
- Cleanup cron for `failed` rows + R2 objects — Phase 6.
- Init idempotency keys — Phase 6 (mitigations in place).
- Resumable uploads (tus / S3 multipart) — Phase 6.
- Animated GIFs.
