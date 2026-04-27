import { customType, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

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
