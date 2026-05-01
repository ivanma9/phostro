# Photo Courier — Phase 2 Implementation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Phase 2 scope:** R2 integration, attendee join, photo upload flow (presigned direct-to-R2), upload registration, server-side metadata + preview generation, and the Postgres-backed `photo_jobs` enqueue contract that Phase 3's worker will consume. **No face detection, embeddings, clustering, or matching in this phase.**

This phase folds in the recommendations from `2026-04-27-photo-courier-implementation-comparison.md`:
- Personal mode is the only visibility mode wired up; `open_pool` and `host_only` remain schema-only.
- Jobs are Postgres-backed (`photo_jobs`); no SQS.
- Operator visibility is added now, not after the worker lands.

---

## End state of Phase 2

A signed-in attendee can open a host's share link, land on a join page that records their `event_members` row, then bulk-pick photos from their camera roll and watch them upload directly to Cloudflare R2 via short-lived presigned PUT URLs. After each upload completes, the client calls a register endpoint; the server inserts a `photos` row, generates a ~2048px JPEG preview via `sharp`, writes it back to R2, extracts EXIF `taken_at` + dimensions, and enqueues a `kind='detect'` row in `photo_jobs` (which has no consumer yet). The host event page shows live upload counters; an internal `/admin/jobs` view shows queue depth, failed jobs, and orphaned photos. All persisted in Postgres + R2; all critical paths covered by Vitest + Playwright.

---

## Exit criteria

Phase 2 is done when all hold:

1. **R2 plumbing** — `lib/r2.ts` issues working presigned PUT and GET URLs against a real R2 bucket; presigned URLs expire ≤ 5 minutes.
2. **Join flow** — visiting `/events/:id/join` while authenticated inserts an `event_members` row with `role='attendee'` (Vitest integration test + Playwright e2e).
3. **Upload flow** — an attendee can multi-select 5 photos in the browser, receive 5 presigned PUTs in one request, upload them in parallel directly to R2, register them via `POST /api/events/:id/photos`, and see the `photos` table populated with originals keys (Playwright e2e using a real R2 test bucket).
4. **Preview generation** — `POST /api/photos/:id/preview-ready` (called by client after the original PUT succeeds, or invoked synchronously inside register) produces a JPEG preview ≤ 600 KB and updates `r2_key_preview`. Verified by reading the preview back from R2 in a Vitest test against a real bucket.
5. **Job enqueue** — every successful photo register inserts a `photo_jobs` row with `state='queued'`, `kind='detect'`, FK to the photo (Vitest integration test).
6. **Operator view** — `/admin/jobs` (gated to a hard-coded `ADMIN_EMAILS` list) renders queue depth, oldest queued job age, last 20 failed jobs, and counts of `photos` per `processing_state`.
7. **Counters** — host event page shows `uploads count`, `unique uploaders count`, refreshed on page load (no live websocket required).
8. **CI green** — Biome, Vitest (unit + integration), and Playwright e2e all pass against a Neon branch + ephemeral R2 prefix.
9. **Cleanup-on-failure** — if register fails after the original is uploaded, a daily reconciliation script (`scripts/reconcile-orphans.ts`) lists R2 keys with no matching `photos` row and supports a `--delete` flag.

---

## Explicitly deferred — not in Phase 2

Do not implement or unblock these in Phase 2:

- Face detection, RetinaFace/SFace integration, ONNX runtime — Phase 3.
- Clustering or `face_detections` / `face_clusters` tables — Phase 3.
- Worker polling logic against `photo_jobs` — Phase 3 writes the consumer.
- Enrollment, `face_profile`, multi-angle capture UX — Phase 4.
- Gallery `You` / `By Me` / `Other` tabs — Phase 5 (we render only a flat "By Me" preview list in Phase 2 for smoke testing).
- `photo_views` / `photo_saves` — Phase 5.
- Bulk save to camera roll — Phase 5.
- Email notifications, expiry reminders, host extension — Phase 6.
- `open_pool` / `host_only` visibility mode UI or authorization — schema only, not enforced or rendered.
- HEIC client-side conversion (we do server-side via `sharp`).
- Multipart uploads / resumable uploads — single-PUT only, 25 MB cap.
- Live counters via websockets — page-load refresh only.
- Cloudflare Images / CDN-side resizing — `sharp` in Next.js runtime for now.

---

## Open questions (called out, not papered over)

1. **`sharp` HEIC support on Vercel runtime.** Production Vercel uses Amazon Linux; `@img/sharp-libvips` has a HEIC variant but is licensed under LGPL and historically required opt-in builds. **Flag as a Milestone 0 device-test entry.** If `sharp` HEIC fails at deploy, fallback is client-side conversion via `heic2any` (adds ~600 KB to first paint). Tracked in Task 7.
2. **Vercel function memory + duration for `sharp`.** A 20 MB HEIC decode + resize can spike to ~1 GB RSS and ~6s wall time. **Decision deferred to deploy step:** if Vercel hobby/free tier limits bite, move preview generation into a separate `/api/photos/preview-worker` Edge-incompatible Node route with explicit `maxDuration = 30` and `memory = 1024`. Worth raising at end of Phase 2.
3. **Where does the preview generation actually run?** Phase 2 choice: synchronously inside `POST /api/events/:id/photos` (the register endpoint streams the original from R2, resizes, writes preview, then commits the row). Alternative: enqueue a `kind='preview'` job and let a stub Node consumer (or a follow-up route) do it async. **Choice:** synchronous in Phase 2 to keep the flow debuggable; revisit if p95 register latency exceeds 4s on real iPhone HEICs.
4. **Presigned URL lifetime.** Choice: 5 minutes. Long enough for a slow cellular upload of a 20 MB HEIC, short enough that link leaks are bounded. Flag as Milestone 0 device-test: confirm 20 MB upload over a throttled 3G profile completes within 5 min.
5. **Should the join page require an explicit "I'm joining" tap, or auto-join on visit?** Choice: auto-join on first authed visit (insert `event_members` if missing, then redirect to event page). Lower friction, matches design doc "implicit on first action." Privacy concern is minimal because no biometric data is captured at this step.
6. **Idempotency on photo register.** A flaky network may retry register after a successful insert. Choice: client passes a UUID `clientPhotoId`; server uses `INSERT ... ON CONFLICT (event_id, client_photo_id) DO NOTHING RETURNING *`. Adds a unique constraint to `photos`.
7. **Storing R2 keys.** Convention: `events/{eventId}/originals/{photoId}.{ext}` and `events/{eventId}/previews/{photoId}.jpg`. The photo UUID is generated server-side in the presigned-URL request, returned to the client, and used by the client when calling register. This binds the key to a row before R2 ever sees the bytes, fixing orphan reconciliation.

## Milestone 0 device-test entries flagged in this phase

- HEIC upload from iPhone Safari over flaky cellular (3G throttle), 20 MB file, 5-min presigned URL.
- 10-photo batch upload from iPhone Safari (verify parallel PUTs, browser doesn't choke).
- 10-photo batch upload from Android Chrome.
- `sharp` HEIC decode on Vercel deploy (smoke test in CI against fixture HEIC).
- Verify R2 CORS allows browser PUT from `localhost:3000` and the deploy origin.

---

## Tasks

### Task 1: Provision R2 bucket and configure CORS

**Files:**
- Edit: `.env.example` (already has placeholders from Phase 1; document expected values)
- Create: `docs/runbooks/r2-setup.md` (operator-facing runbook)

**Step 1: Create R2 bucket via Cloudflare dashboard**

In the Cloudflare dashboard → R2 → Create bucket:
- Name: `phostro-dev` (and `phostro-prod` later)
- Location hint: ENAM (us-east) to match Neon region
- Default object lifetime: none (we manage cleanup explicitly)

**Step 2: Generate R2 API tokens**

R2 → Manage R2 API tokens → Create API token:
- Permissions: Object Read & Write
- Specify bucket: `phostro-dev`
- TTL: 90 days
- Capture `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` into local `.env`.

**Step 3: Configure bucket CORS**

In bucket settings → CORS, add:
```json
[
  {
    "AllowedOrigins": ["http://localhost:3000", "https://*.vercel.app", "https://phostro.app"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

**Step 4: Document in runbook** at `docs/runbooks/r2-setup.md`. Capture: bucket name, CORS rules, key rotation cadence (90 days), and how to nuke a bucket for a clean test.

**Expected output:** Bucket exists; tokens in `.env`; CORS allows `PUT` from dev origin.

**Verification:** From another terminal, `curl -X PUT --upload-file /etc/hosts <presigned-url>` against a hand-rolled presigned URL succeeds (we'll do this end-to-end in Task 3).

**Commit:**
```bash
git add docs/runbooks/r2-setup.md .env.example
git commit -m "docs: add R2 bucket setup runbook"
```

---

### Task 2: Schema — `photos` table

**Files:**
- Edit: `db/schema.ts`

**Step 1: Add the `photos` table**

```ts
import { boolean, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const processingState = ['pending_upload', 'uploaded', 'preview_ready', 'queued', 'processed', 'failed'] as const

export const photos = pgTable('photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  uploaderUserId: uuid('uploader_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientPhotoId: text('client_photo_id').notNull(), // client-provided idempotency key
  originalFilename: text('original_filename'),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  width: integer('width'),
  height: integer('height'),
  takenAt: timestamp('taken_at'),  // from EXIF
  uploadedAt: timestamp('uploaded_at').notNull().defaultNow(),
  r2KeyOriginal: text('r2_key_original').notNull(),
  r2KeyPreview: text('r2_key_preview'),
  processingState: text('processing_state', { enum: processingState }).notNull().default('pending_upload'),
  hasDetectedFaces: boolean('has_detected_faces'), // null until Phase 3
  deletedAt: timestamp('deleted_at'),
}, (t) => ({
  byEvent: index('photos_event_idx').on(t.eventId),
  byUploader: index('photos_uploader_idx').on(t.uploaderUserId),
  byState: index('photos_state_idx').on(t.processingState),
  uniqClient: uniqueIndex('photos_event_client_uniq').on(t.eventId, t.clientPhotoId),
}))
```

**Step 2: Generate + apply migration**
```bash
pnpm db:generate && pnpm db:migrate
```

**Step 3: Verify in Drizzle Studio**
```bash
pnpm db:studio
```
Confirm `photos` table; confirm the `(event_id, client_photo_id)` unique index.

**Expected output:** new migration `db/migrations/000X_*.sql` with `CREATE TABLE photos` plus indexes.

**Verification:**
```bash
psql "$DATABASE_URL" -c "\d photos"
```
shows the unique index and FKs.

**Commit:**
```bash
git add db/schema.ts db/migrations
git commit -m "feat: add photos table with idempotency index"
```

---

### Task 3: Schema — `photo_jobs` table

**Files:**
- Edit: `db/schema.ts`

**Step 1: Add the table** (cross-phase contract — Phase 3's worker reads/writes this exact shape)

<!-- Column shape aligned with Phase 3's worker requirements (claimed_at/claimed_by, max_attempts, last_error_at). -->

```ts
export const photoJobKinds = ['detect', 'preview'] as const  // 'preview' reserved for future async-preview path; 'kind' is a Phase 2 detail Phase 3 does not add
export const photoJobStates = ['queued', 'claimed', 'succeeded', 'failed'] as const

export const photoJobs = pgTable('photo_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  photoId: uuid('photo_id').notNull().references(() => photos.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: photoJobKinds }).notNull(),
  state: text('state', { enum: photoJobStates }).notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  claimedAt: timestamp('claimed_at'),
  claimedBy: text('claimed_by'),  // worker instance id
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at'),
  succeededAt: timestamp('succeeded_at'),
  failedAt: timestamp('failed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  byState: index('photo_jobs_state_idx').on(t.state, t.createdAt),
  byPhoto: index('photo_jobs_photo_idx').on(t.photoId),
  // A photo can have at most one non-failed job; resubmissions after failure are allowed.
  uniqActiveJob: uniqueIndex('photo_jobs_photo_active_uniq')
    .on(t.photoId)
    .where(sql`state in ('queued','claimed','succeeded')`),
}))
```

**Step 2: Generate + apply.**
```bash
pnpm db:generate && pnpm db:migrate
```

**Expected output:** new migration; `photo_jobs` table exists.

**Verification:** `psql ... -c "\d photo_jobs"` shows expected columns + indexes.

**Commit:**
```bash
git add db/schema.ts db/migrations
git commit -m "feat: add photo_jobs table for Postgres-backed work queue"
```

---

### Task 4: R2 client wrapper (TDD)

**Files:**
- Create: `lib/r2.ts`, `tests/r2.test.ts`

**Step 1: Install the AWS SDK v3 (S3 compatible).**
```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

**Step 2: Write the test** at `tests/r2.test.ts` (uses the real R2 bucket — gated by env)

```ts
import { test, expect } from 'vitest'
import { getPresignedPutUrl, getPresignedGetUrl, putObject, getObjectStream } from '@/lib/r2'

const itLive = process.env.R2_ACCOUNT_ID ? test : test.skip

itLive('round-trips a small object', async () => {
  const key = `tests/sanity-${Date.now()}.txt`
  const url = await getPresignedPutUrl(key, 'text/plain', 60)
  const res = await fetch(url, { method: 'PUT', body: 'hello', headers: { 'content-type': 'text/plain' } })
  expect(res.ok).toBe(true)
  const get = await getPresignedGetUrl(key, 60)
  const back = await fetch(get).then(r => r.text())
  expect(back).toBe('hello')
})
```

**Step 3: Implement** `lib/r2.ts`

```ts
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const accountId = process.env.R2_ACCOUNT_ID!
export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})

const BUCKET = process.env.R2_BUCKET!

export async function getPresignedPutUrl(key: string, contentType: string, ttlSeconds = 300) {
  return getSignedUrl(
    r2,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: ttlSeconds },
  )
}

export async function getPresignedGetUrl(key: string, ttlSeconds = 300) {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: ttlSeconds })
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }))
}

export async function getObjectStream(key: string): Promise<ReadableStream<Uint8Array>> {
  const out = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  return out.Body!.transformToWebStream()
}
```

**Step 4: Run tests.** Locally with R2 env populated: `pnpm test tests/r2.test.ts` → 1 pass. In CI without R2 env → skipped.

**Expected output:** test passes locally; CI skips it; module exports the four helpers Phase 3 will reuse.

**Verification:** Inspect the R2 bucket in Cloudflare console — see `tests/sanity-*.txt` keys appearing. Manually delete after.

**Commit:**
```bash
git add lib/r2.ts tests/r2.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add R2 client wrapper with presigned URL helpers"
```

---

### Task 5: API route — request presigned PUT URLs (batch)

**Files:**
- Create: `app/api/events/[id]/uploads/route.ts`, `tests/api/uploads-presign.test.ts`

The client posts `{ files: [{ clientPhotoId, contentType, byteSize }, ...] }` and gets back per-file `{ photoId, putUrl, key }`.

**Step 1: Write integration test** that mocks `getCurrentUser`, seeds an event + membership, and asserts:
- 401 when unauthenticated
- 403 when not a member
- 400 when any `byteSize > 25 * 1024 * 1024`
- 400 when any `contentType` is not in `['image/jpeg','image/png','image/heic','image/heif','image/webp']`
- 200 returns one entry per input with a presigned URL containing `X-Amz-Signature`

**Step 2: Implement** `app/api/events/[id]/uploads/route.ts`

```ts
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { events, eventMembers } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/current-user'
import { getPresignedPutUrl } from '@/lib/r2'
import { joinEvent } from '@/lib/events/join'
import { randomUUID } from 'node:crypto'

const MAX_BYTES = 25 * 1024 * 1024
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  // Idempotent membership via Phase 1's helper. Host already has 'host';
  // joinEvent only inserts when no row exists, so this is safe to call.
  const result = await joinEvent(eventId, user.id)
  if (result === 'not_found') return NextResponse.json({ error: 'event not found' }, { status: 404 })

  const { files } = await req.json() as { files: { clientPhotoId: string; contentType: string; byteSize: number }[] }
  if (!Array.isArray(files) || files.length === 0 || files.length > 50) {
    return NextResponse.json({ error: 'invalid batch' }, { status: 400 })
  }
  for (const f of files) {
    if (!ALLOWED.has(f.contentType)) return NextResponse.json({ error: `unsupported type ${f.contentType}` }, { status: 400 })
    if (f.byteSize > MAX_BYTES) return NextResponse.json({ error: 'file too large' }, { status: 400 })
  }

  const out = await Promise.all(files.map(async (f) => {
    const photoId = randomUUID()
    const ext = f.contentType.split('/')[1].replace('jpeg', 'jpg')
    const key = `events/${eventId}/originals/${photoId}.${ext}`
    const putUrl = await getPresignedPutUrl(key, f.contentType, 300)
    return { photoId, key, putUrl, clientPhotoId: f.clientPhotoId }
  }))

  return NextResponse.json({ uploads: out })
}
```

**Step 3: Run tests.** Expect green.

**Expected output:** route returns N presigned URLs in one round-trip; idempotently ensures the user is a member.

**Verification:**
- Vitest `tests/api/uploads-presign.test.ts` passes.
- Manual smoke: `curl -X POST -H 'cookie: pc_session=...' http://localhost:3000/api/events/<id>/uploads -d '{"files":[{"clientPhotoId":"abc","contentType":"image/jpeg","byteSize":1024}]}'` returns one URL.

**Commit:**
```bash
git add app/api/events/[id]/uploads tests/api/uploads-presign.test.ts
git commit -m "feat: presigned-URL batch endpoint and idempotent membership"
```

---

### Task 6: API route — register uploaded photo

**Files:**
- Create: `app/api/events/[id]/photos/route.ts`, `tests/api/photos-register.test.ts`

The client POSTs after each successful PUT: `{ photoId, clientPhotoId, key, contentType, byteSize, originalFilename }`. The server inserts the row in `processing_state='uploaded'`. Preview generation runs in Task 7 (chained from this route).

**Step 1: Test** asserts:
- 401 / 403 paths
- A successful insert produces a `photos` row with `processing_state='uploaded'`
- Re-posting the same `clientPhotoId` returns 200 with the existing row, no duplicate

**Step 2: Implement.**

```ts
// app/api/events/[id]/photos/route.ts
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { photos, photoJobs, eventMembers } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { getCurrentUser } from '@/lib/auth/current-user'
import { generatePreview } from '@/lib/preview'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: eventId } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const [m] = await db.select().from(eventMembers).where(
    and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, user.id)))
  if (!m) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json()
  const { photoId, clientPhotoId, key, contentType, byteSize, originalFilename } = body

  // Idempotent insert
  const inserted = await db.insert(photos).values({
    id: photoId,
    eventId,
    uploaderUserId: user.id,
    clientPhotoId,
    contentType,
    byteSize,
    originalFilename,
    r2KeyOriginal: key,
    processingState: 'uploaded',
  }).onConflictDoNothing({ target: [photos.eventId, photos.clientPhotoId] }).returning()

  const photo = inserted[0] ?? (await db.select().from(photos).where(
    and(eq(photos.eventId, eventId), eq(photos.clientPhotoId, clientPhotoId)))).at(0)!

  // Generate preview synchronously (Task 7)
  try {
    const { previewKey, width, height, takenAt } = await generatePreview(photo)
    await db.update(photos).set({
      r2KeyPreview: previewKey, width, height, takenAt,
      processingState: 'preview_ready',
    }).where(eq(photos.id, photo.id))
  } catch (err) {
    await db.update(photos).set({ processingState: 'failed' }).where(eq(photos.id, photo.id))
    throw err
  }

  // Enqueue detect job (consumer arrives in Phase 3)
  await db.insert(photoJobs).values({ photoId: photo.id, kind: 'detect' })
  await db.update(photos).set({ processingState: 'queued' }).where(eq(photos.id, photo.id))

  return NextResponse.json({ photo: { id: photo.id, processingState: 'queued' } })
}
```

**Step 3: Run tests.**

**Expected output:** photo row exists; `photo_jobs` row exists with `kind='detect'`; `processing_state='queued'`.

**Verification:**
- Vitest test green.
- Drizzle Studio shows the new rows.

**Commit:**
```bash
git add app/api/events/[id]/photos tests/api/photos-register.test.ts
git commit -m "feat: register uploaded photo, generate preview, enqueue detect job"
```

---

### Task 7: Preview generation with `sharp` (TDD)

**Files:**
- Create: `lib/preview.ts`, `tests/preview.test.ts`, `tests/fixtures/sample.jpg`, `tests/fixtures/sample.heic`

**Step 1: Install `sharp` and `exifr`.**
```bash
pnpm add sharp exifr
```

`sharp` includes libvips with HEIC support on supported runtimes. **Milestone 0 device-test: confirm Vercel build does not fail and that HEIC decode works.** If it fails, fall back: keep `sharp` JPEG/PNG path, run HEIC fixtures through `heic-decode` server-side, document it.

**Step 2: Test** with both fixtures.

```ts
import { test, expect } from 'vitest'
import { generatePreview } from '@/lib/preview'
import { db } from '@/db'
import { photos } from '@/db/schema'

const itLive = process.env.R2_ACCOUNT_ID ? test : test.skip

itLive('downscales a JPEG to ≤ 2048px and ≤ 600KB', async () => {
  // Seed a photo row that points at a pre-uploaded fixture in R2 (Task 4 helper).
  // Call generatePreview, assert the returned key, fetch the preview, assert dimensions and bytes.
})
itLive('handles HEIC originals', async () => { /* ... */ })
itLive('reads EXIF takenAt when present', async () => { /* ... */ })
```

**Step 3: Implement** `lib/preview.ts`

```ts
import sharp from 'sharp'
import exifr from 'exifr'
import { getObjectStream, putObject } from './r2'
import type { InferSelectModel } from 'drizzle-orm'
import type { photos } from '@/db/schema'

const MAX_DIM = 2048
const MAX_BYTES = 600 * 1024

export async function generatePreview(p: InferSelectModel<typeof photos>) {
  const stream = await getObjectStream(p.r2KeyOriginal)
  const buf = Buffer.from(await new Response(stream).arrayBuffer())
  const exif = await exifr.parse(buf, { tiff: true, ifd0: true, exif: true }).catch(() => null)
  const takenAt = exif?.DateTimeOriginal ?? exif?.CreateDate ?? null

  let quality = 85
  let preview: Buffer
  let meta: sharp.OutputInfo
  do {
    const out = await sharp(buf, { failOnError: false })
      .rotate()
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })
    preview = out.data; meta = out.info
    if (preview.byteLength <= MAX_BYTES || quality <= 60) break
    quality -= 10
  } while (true)

  const previewKey = p.r2KeyOriginal
    .replace('/originals/', '/previews/')
    .replace(/\.[^.]+$/, '.jpg')
  await putObject(previewKey, preview, 'image/jpeg')
  return { previewKey, width: meta.width, height: meta.height, takenAt }
}
```

**Step 4: Run tests** locally with R2 env. Skipped in CI for speed; covered by Task 16's e2e instead.

**Expected output:** previews land in R2 under `events/<id>/previews/<photoId>.jpg`, ≤ 600 KB, ≤ 2048px.

**Verification:** Inspect R2 console for preview keys; download and view.

**Commit:**
```bash
git add lib/preview.ts tests/preview.test.ts tests/fixtures package.json pnpm-lock.yaml
git commit -m "feat: server-side preview generation with sharp + EXIF taken_at"
```

---

### Task 8: Reconciliation script for orphan R2 keys

**Files:**
- Create: `scripts/reconcile-orphans.ts`

**Step 1: Implement.** Lists every R2 key under `events/`, joins against `photos.r2_key_original` and `photos.r2_key_preview`, prints any keys with no matching row. With `--delete`, removes them.

```ts
// scripts/reconcile-orphans.ts
import { ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { r2 } from '@/lib/r2'
import { db } from '@/db'
import { photos } from '@/db/schema'

const BUCKET = process.env.R2_BUCKET!

async function main() {
  const remoteKeys: string[] = []
  let token: string | undefined
  do {
    const out = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'events/', ContinuationToken: token }))
    out.Contents?.forEach(o => o.Key && remoteKeys.push(o.Key))
    token = out.NextContinuationToken
  } while (token)

  const all = await db.select({ o: photos.r2KeyOriginal, p: photos.r2KeyPreview }).from(photos)
  const known = new Set([...all.map(x => x.o), ...all.map(x => x.p).filter(Boolean) as string[]])

  const orphans = remoteKeys.filter(k => !known.has(k))
  console.log(`Found ${orphans.length} orphan(s)`)
  for (const k of orphans) console.log(`  ${k}`)

  if (process.argv.includes('--delete')) {
    for (const k of orphans) {
      await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k }))
      console.log(`deleted ${k}`)
    }
  }
}
main()
```

**Step 2: Run dry-run locally.**
```bash
pnpm tsx scripts/reconcile-orphans.ts
```

**Expected output:** prints orphan keys (probably 0 if you've been tidy).

**Verification:** Manually upload a stray key with `aws s3 cp` against the R2 endpoint, re-run, see it listed.

**Commit:**
```bash
git add scripts/reconcile-orphans.ts
git commit -m "feat: orphan R2 key reconciliation script"
```

---

### Task 9: Join page

**Status: already shipped in Phase 1.** Phase 1 created `app/(app)/events/[id]/join/page.tsx` (auto-joins on first authed visit and redirects to the event page) and `lib/events/join.ts` exporting `joinEvent(eventId, userId): Promise<'joined' | 'already_member' | 'not_found'>`. The sign-in `next=` redirect is also wired.

**This task in Phase 2 is verification-only — do not recreate the page or helper.**

**Step 1: Verify the helper signature.** Confirm `lib/events/join.ts` still exports `joinEvent` with the documented return shape. Phase 2 Task 5 imports it for idempotent membership insertion in the upload-presign route.

**Step 2: Verify the join page behavior.** Visit `/events/<id>/join` while authed; confirm `event_members` row appears and you land on `/events/<id>`. Visit while unauthed; confirm redirect to `/auth/signin?next=/events/<id>/join` and round-trip to the event page after sign-in.

**Step 3: Confirm Vitest coverage.** A helper test for `joinEvent` should exist from Phase 1 (`tests/events/join.test.ts` or equivalent). If not, add one — `joinEvent` returns `'joined'` on first call, `'already_member'` on second, `'not_found'` for an invalid event id.

**Step 4: No commit unless a test was added.** This task produces no production code in Phase 2.

**If the helper differs from the documented shape** (e.g., a future refactor renamed it or changed return values), update Phase 2 Task 5's import and call site, *not* the Phase 1 implementation. Phase 1 is the canonical source for membership semantics.

(removed: original Step 1-4 to create membership.ts + join page + sign-in next= — all done in Phase 1.)

**Skipped commit** — no new files in this task. If a Vitest test was added in Step 3, commit it under `test:`.

---

### Task 10: Upload UI component

**Files:**
- Create: `components/UploadDropzone.tsx`, `components/UploadProgress.tsx`
- Edit: `app/(app)/events/[id]/page.tsx`

**Step 1: Implement client component** `components/UploadDropzone.tsx`. Key behaviors:
- `<input type="file" accept="image/*" multiple capture="environment">` (the `capture` attribute lets iOS Safari open the camera; without it, only camera roll).
- For each selected file, generate a `clientPhotoId` (UUID in browser).
- Single POST to `/api/events/<id>/uploads` with the batch.
- For each returned URL, run `fetch(url, { method: 'PUT', body: file, headers: { 'content-type': file.type } })` in parallel (cap concurrency at 4 to be polite).
- After each PUT resolves, POST to `/api/events/<id>/photos` with the metadata.
- Track per-file progress in state and render `<UploadProgress>` rows.

(Code shape — abbreviated.)

```tsx
'use client'
import { useState } from 'react'

type Item = { file: File; clientPhotoId: string; status: 'pending' | 'uploading' | 'registering' | 'done' | 'error'; error?: string }

export function UploadDropzone({ eventId }: { eventId: string }) {
  const [items, setItems] = useState<Item[]>([])

  async function onSelect(files: FileList) {
    const next: Item[] = Array.from(files).map(f => ({ file: f, clientPhotoId: crypto.randomUUID(), status: 'pending' }))
    setItems(prev => [...prev, ...next])
    // Batch presign
    const presign = await fetch(`/api/events/${eventId}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: next.map(i => ({ clientPhotoId: i.clientPhotoId, contentType: i.file.type, byteSize: i.file.size })) }),
    }).then(r => r.json())
    // Upload + register per file with concurrency cap
    // ...
  }

  return (
    <div>
      <input type="file" accept="image/*" multiple onChange={e => e.target.files && onSelect(e.target.files)} />
      <ul>{items.map(i => <UploadProgress key={i.clientPhotoId} item={i} />)}</ul>
    </div>
  )
}
```

**Step 2: Mount it** on the event page (only show to members). Keep the existing `ShareLink` from Phase 1.

**Step 3: Manual smoke** — sign in as host, create event, drop 3 photos, watch them appear in R2 + Drizzle Studio.

**Expected output:** photos appear in R2 console; `photos`, `photo_jobs`, `event_members` rows populated.

**Verification:** Manual + Playwright in Task 16.

**Commit:**
```bash
git add components app/(app)/events/[id]/page.tsx
git commit -m "feat: upload dropzone with batched presign and parallel direct-to-R2 uploads"
```

---

### Task 11: Event page upload counters

**Files:**
- Edit: `app/(app)/events/[id]/page.tsx`

**Step 1:** Server-side, fetch `count(distinct uploader_user_id)` and `count(*)` from `photos` where `event_id = ? and deleted_at is null`. Render `12 photos · 4 contributors`.

**Step 2: Manual smoke.**

**Expected output:** counters render on initial page load; refresh updates them.

**Commit:**
```bash
git add app/(app)/events/[id]/page.tsx
git commit -m "feat: event page upload + contributor counters"
```

---

### Task 12: Minimal "By Me" preview list (debug-only smoke)

**Files:**
- Edit: `app/(app)/events/[id]/page.tsx` (or create a sub-section)

**Step 1:** Below the upload dropzone, render the current user's own uploads (`photos.uploader_user_id = me`) as a flat thumbnail grid using preview presigned GET URLs. This is **not** the real Phase 5 gallery — it's a smoke test that the round-trip works.

**Step 2:** Generate presigned GET URLs server-side at request time (5-minute TTL).

**Expected output:** uploader sees their own previews on the event page.

**Verification:** Manual smoke. Real "By Me" tab + visibility-mode filtering happens in Phase 5.

**Commit:**
```bash
git add app/(app)/events/[id]/page.tsx
git commit -m "feat: smoke-test 'By Me' grid for uploaded previews"
```

---

### Task 13: Operator view — `/admin/jobs`

**Files:**
- Create: `app/(app)/admin/jobs/page.tsx`, `lib/auth/is-admin.ts`

**Step 1: Implement guard.** Hard-coded allowlist for now.

```ts
// lib/auth/is-admin.ts
const ADMINS = (process.env.ADMIN_EMAILS ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
export function isAdmin(contact: string | undefined | null): boolean {
  return !!contact && ADMINS.includes(contact.toLowerCase())
}
```

Add `ADMIN_EMAILS` to `.env.example`.

**Step 2: Implement page.** Server component. `redirect('/')` if not admin. Otherwise show:
- Counts of `photos` grouped by `processing_state`.
- Queue depth: `count(*) where state='queued'`.
- Oldest queued job age: `now() - min(scheduled_for)`.
- Last 20 jobs where `state='failed'` with `last_error`.

**Step 3: Manual smoke** — set `ADMIN_EMAILS=you@you.com` in `.env`, visit `/admin/jobs`.

**Expected output:** admin-only diagnostic table renders.

**Verification:** Vitest test for `isAdmin`. Manual page check.

**Commit:**
```bash
git add app/(app)/admin lib/auth/is-admin.ts tests/auth/is-admin.test.ts .env.example
git commit -m "feat: operator /admin/jobs view for queue + failure visibility"
```

---

### Task 14: Authorization helper for photo reads

**Files:**
- Create: `lib/photos/visibility.ts`

This is a stub for Personal-mode filtering. In Phase 2 we only need: "may this user see this photo?" The Phase 2 answer for the smoke gallery is: uploader can see their own. Phase 5 expands this to face-matched + `Other`.

```ts
// lib/photos/visibility.ts
import type { InferSelectModel } from 'drizzle-orm'
import type { photos } from '@/db/schema'

export function canViewInPhase2(viewerUserId: string, photo: InferSelectModel<typeof photos>) {
  return photo.uploaderUserId === viewerUserId
}
```

Phase 5 will replace `canViewInPhase2` with real `personal | open_pool | host_only` logic against `face_clusters`. The helper exists now to keep the call site stable.

**Commit:**
```bash
git add lib/photos/visibility.ts
git commit -m "chore: stub photo visibility helper, full logic in Phase 5"
```

---

### Task 15: Update CI to cover Phase 2

**Files:**
- Edit: `.github/workflows/ci.yml`

**Step 1: Add R2 mock-mode env vars** so CI doesn't need real R2 creds. The `R2_ACCOUNT_ID` env var is the gate — leave unset in CI; live R2 tests skip themselves.

**Step 2: Run Playwright (no live R2)** by mocking `lib/r2.ts` with MSW or by exposing a `__test/upload-stub` route that bypasses R2. Choice: in Phase 2 keep e2e against a real R2 dev bucket using a CI secret, scoped to a `ci/<run-id>/` prefix that's nuked on teardown. Add a workflow step:

```yaml
      - run: pnpm exec playwright install --with-deps chromium
      - env:
          R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_BUCKET: ${{ secrets.R2_BUCKET_DEV }}
        run: pnpm exec playwright test
```

**Step 3:** Add a teardown step that runs `pnpm tsx scripts/reconcile-orphans.ts --delete --prefix ci/${{ github.run_id }}/` (extend the script with a `--prefix` flag).

**Expected output:** CI green; uploaded fixtures auto-cleaned.

**Commit:**
```bash
git add .github/workflows/ci.yml scripts/reconcile-orphans.ts
git commit -m "ci: run Playwright with real R2 dev bucket; auto-cleanup CI artifacts"
```

---

### Task 16: E2E — full attendee upload journey (Playwright)

**Files:**
- Create: `e2e/attendee-uploads.spec.ts`, `e2e/fixtures/photo-1.jpg`, `e2e/fixtures/photo-2.jpg`

**Step 1: Add a test-only auth bypass.** Phase 1's plan calls for adding this in Phase 1.5. If not yet present, add it now: `app/api/__test/login/route.ts` (gated by `NODE_ENV !== 'production'`) accepts `{ contact, name }` and creates a session directly.

**Step 2: Spec.**

```ts
import { test, expect } from '@playwright/test'

test('host creates event, attendee joins via link, uploads two photos', async ({ browser }) => {
  // Host context
  const host = await browser.newContext()
  await host.request.post('/api/__test/login', { data: { contact: 'host@e2e.com', name: 'Host' } })
  const hostPage = await host.newPage()
  await hostPage.goto('/events/new')
  await hostPage.getByPlaceholder('Event name').fill('E2E Party')
  await hostPage.getByRole('button', { name: /create event/i }).click()
  const eventUrl = hostPage.url()
  const eventId = eventUrl.split('/').pop()!

  // Attendee context
  const attendee = await browser.newContext()
  await attendee.request.post('/api/__test/login', { data: { contact: 'att@e2e.com', name: 'Attendee' } })
  const attPage = await attendee.newPage()
  await attPage.goto(`/events/${eventId}/join`)
  await expect(attPage).toHaveURL(`/events/${eventId}`)

  // Upload two fixtures
  await attPage.setInputFiles('input[type="file"]', ['e2e/fixtures/photo-1.jpg', 'e2e/fixtures/photo-2.jpg'])
  await expect(attPage.getByText(/2 photos · 1 contributor/i)).toBeVisible({ timeout: 30_000 })

  // Host sees the same counters
  await hostPage.reload()
  await expect(hostPage.getByText(/2 photos · 2 contributor/i)).toBeVisible() // host counts as a contributor only if they upload — adjust assertion
})
```

**Step 3: Run.**
```bash
pnpm exec playwright test e2e/attendee-uploads.spec.ts
```

**Expected output:** test passes against real R2 dev bucket.

**Verification:** CI green. R2 console shows `events/<id>/originals/*.jpg` and `events/<id>/previews/*.jpg`.

**Commit:**
```bash
git add e2e app/api/__test
git commit -m "test: e2e attendee upload journey with R2 round-trip"
```

---

### Task 17: Documentation pass

**Files:**
- Edit: `README.md` (Phase 1 should already exist; add Phase 2 setup)
- Create: `docs/runbooks/uploads.md`

Cover: how to provision R2, how to run the orphan reconciliation, how to read `/admin/jobs`, where preview generation runs and what to watch for on Vercel deploy.

**Commit:**
```bash
git add README.md docs/runbooks/uploads.md
git commit -m "docs: Phase 2 setup and uploads runbook"
```

---

## Phase 2 review checkpoint

Before declaring Phase 2 done, run **all** of the following and capture a paste of each result in the PR description:

1. `pnpm biome check .` — clean.
2. `pnpm test` — all unit + integration green (Vitest).
3. `pnpm exec playwright test` — all e2e green against a real R2 dev bucket.
4. `pnpm db:migrate` — applies cleanly to a fresh Neon branch.
5. **Manual device smoke (Milestone 0 entries):**
   - iPhone Safari, real photo from camera roll, JPEG → upload completes; preview visible.
   - iPhone Safari, HEIC photo from camera roll → upload completes; preview is JPEG; preview visible.
   - iPhone Safari, 10-photo batch → all 10 land; no UI deadlocks.
   - iPhone Safari with 3G throttling, 20 MB HEIC → upload completes within 5-min presigned window or surfaces a clear retry UX.
   - Android Chrome, 10-photo batch → all 10 land.
6. `pnpm tsx scripts/reconcile-orphans.ts` against the dev bucket post-test → reports 0 orphans.
7. `/admin/jobs` shows: `queued = N, claimed = 0, succeeded = 0, failed = 0` (Phase 3 is what flips them to succeeded/failed).
8. Run `superpowers:requesting-code-review` and address Critical/Important findings before merging.
9. Verify cross-phase contracts named in this doc are still accurate (table shapes, helper exports). If anything drifted, update Phase 3's outline before starting it.
10. Decide on the open questions flagged above (especially #1 sharp HEIC and #2 Vercel sizing) — capture answers in the PR or in a follow-up `decisions.md`.

Phase 3 should not start until all 10 are checked.
