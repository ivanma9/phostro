import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { and, desc, eq, gt, sql } from 'drizzle-orm'

const vector = (name: string, dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dim})`,
    toDriver: (v) => `[${v.join(',')}]`,
    fromDriver: (s) => JSON.parse(s),
  })(name)

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  contact: text('contact').notNull().unique(),
  contactType: text('contact_type', { enum: ['email', 'phone'] }).notNull(),
  faceEmbedding: vector('face_embedding', 128),
  faceQualityScore: integer('face_quality_score'),
  faceEnrolledAt: timestamp('face_enrolled_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  hostUserId: uuid('host_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  visibilityMode: text('visibility_mode', {
    enum: ['personal', 'open_pool', 'host_only'],
  })
    .notNull()
    .default('personal'),
  lifespanDays: integer('lifespan_days').notNull().default(7),
  expiresAt: timestamp('expires_at').notNull(),
  extensionUsed: boolean('extension_used').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const magicLinkTokens = pgTable(
  'magic_link_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contact: text('contact').notNull(),
    contactType: text('contact_type', { enum: ['email', 'phone'] }).notNull(),
    intendedName: text('intended_name'),
    intendedRedirect: text('intended_redirect'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('magic_link_tokens_contact_idx').on(t.contact)],
)

export const eventMembers = pgTable(
  'event_members',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['host', 'attendee'] }).notNull(),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.userId] })],
)

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

export const photoJobs = pgTable(
  'photo_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    photoId: uuid('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('detect'),
    // TS literal union must stay in sync with CHECK constraint below.
    state: text('state', {
      enum: ['queued', 'claimed', 'succeeded', 'failed'],
    })
      .notNull()
      .default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    claimedAt: timestamp('claimed_at'),
    claimedBy: text('claimed_by'),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at'),
    succeededAt: timestamp('succeeded_at'),
    failedAt: timestamp('failed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    // NOTE: callers MUST set updatedAt = new Date() on every state-mutating UPDATE.
    // No trigger; helpers in lib/jobs/ (Tasks 5–6) own this discipline.
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('photo_jobs_photo_id_idx').on(t.photoId),
    // Composite index supports Task 5 SKIP-LOCKED claim query:
    // SELECT ... WHERE state = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    index('photo_jobs_state_created_idx').on(t.state, t.createdAt),
    uniqueIndex('photo_jobs_photo_id_kind_active_uidx')
      .on(t.photoId, t.kind)
      .where(sql`state IN ('queued','claimed','succeeded')`),
    check(
      'photo_jobs_state_check',
      sql`state IN ('queued','claimed','succeeded','failed')`,
    ),
  ],
)

// CIRCULAR FK PAIR — read carefully before modifying.
//
//   face_detections.cluster_id            → face_clusters.id    (ON DELETE SET NULL)
//   face_clusters.representative_detection_id → face_detections.id (ON DELETE SET NULL)
//
// Drizzle 0.45's TypeScript types cannot resolve a fully circular FK pair when both
// sides use inline `.references()` — the compiler raises TS7022/TS7024 because each
// table's type depends on the other's. To work around this we:
//   1. Declare faceClusters FIRST. faceDetections.clusterId references it via the
//      lazy `.references(() => faceClusters.id)` form (Drizzle resolves the thunk at
//      codegen time, so forward reference is fine).
//   2. Declare face_clusters.representative_detection_id as a plain uuid() column with
//      NO inline FK. The back-reference is appended to the generated migration as a
//      raw ALTER TABLE statement (see 0006_*.sql).
//
// SNAPSHOT DRIFT WARNING: the back-FK is NOT tracked in db/migrations/meta/*.json.
// Consequence: `pnpm db:generate` will not see this FK in the schema model, so any
// future edit that *adds* the FK to faceClusters via foreignKey()/.references() will
// produce a duplicate ADD CONSTRAINT migration. If you need to modify this FK, edit
// the SQL of migration 0006 OR write a new explicit migration. Do NOT add the FK to
// the Drizzle schema and regenerate — it will not converge.
export const faceClusters = pgTable('face_clusters', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  // Nullable; recomputed by clustering job. FK to face_detections.id added in
  // migration 0006 as raw ALTER TABLE — see comment block above.
  representativeDetectionId: uuid('representative_detection_id'),
  representativeEmbedding: vector('representative_embedding', 128).notNull(),
  memberCount: integer('member_count').notNull().default(1),
  // Phase 4 sets this; intentionally NULL in Phase 3.
  // ON DELETE SET NULL: if the user account is deleted the cluster stays unclaimed.
  claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const faceDetections = pgTable(
  'face_detections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    photoId: uuid('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    bboxX1: real('bbox_x1').notNull(),
    bboxY1: real('bbox_y1').notNull(),
    bboxX2: real('bbox_x2').notNull(),
    bboxY2: real('bbox_y2').notNull(),
    confidence: real('confidence').notNull(),
    landmarksJson: jsonb('landmarks_json').notNull(),
    embedding: vector('embedding', 128).notNull(),
    // Nullable; set by clustering job. ON DELETE SET NULL so losing a cluster
    // doesn't cascade-delete detection rows.
    clusterId: uuid('cluster_id').references(() => faceClusters.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('face_detections_embedding_idx')
      .using('ivfflat', t.embedding.op('vector_cosine_ops'))
      .with({ lists: 100 }),
  ],
)

// VIEW CONTRACT: failed_photo_jobs_recent (id, photo_id, event_id, uploader_user_id,
// attempts, last_error, last_error_at, failed_at). Operator runbook (Task 17) and
// failure-visibility checks depend on this column set. Renaming or removing
// columns from photo_jobs/photos requires updating this view in the same migration.
export const failedPhotoJobsRecent = pgView('failed_photo_jobs_recent').as(
  (qb) =>
    qb
      .select({
        id: photoJobs.id,
        photoId: photoJobs.photoId,
        eventId: photos.eventId,
        uploaderUserId: photos.uploaderUserId,
        attempts: photoJobs.attempts,
        lastError: photoJobs.lastError,
        lastErrorAt: photoJobs.lastErrorAt,
        failedAt: photoJobs.failedAt,
      })
      .from(photoJobs)
      .innerJoin(photos, eq(photos.id, photoJobs.photoId))
      .where(
        and(
          eq(photoJobs.state, 'failed'),
          gt(photoJobs.failedAt, sql`now() - interval '7 days'`),
        ),
      )
      .orderBy(desc(photoJobs.failedAt)),
)
