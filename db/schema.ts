import {
  boolean,
  customType,
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

export const magicLinkTokens = pgTable('magic_link_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  contact: text('contact').notNull(),
  contactType: text('contact_type', { enum: ['email', 'phone'] }).notNull(),
  intendedName: text('intended_name'),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

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
