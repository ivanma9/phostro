import { config } from 'dotenv'

config({ path: '.env.local' })
config({ path: '.env' })

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  process.env.SESSION_SECRET = 'test_session_secret_at_least_32_characters_long_!!'
}
// Vitest sets NODE_ENV to 'test' automatically; no need to assign.
process.env.APP_URL ??= 'http://localhost:3000'
if (!process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = 'test_resend_api_key'
