import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

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
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('photo_jobs_photo_id_idx').on(t.photoId),
    index('photo_jobs_state_idx').on(t.state),
    // Partial unique index added as raw SQL in migration:
    // UNIQUE (photo_id, kind) WHERE state IN ('queued','claimed','succeeded')
  ],
)
