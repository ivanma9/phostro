import { defineConfig, devices } from '@playwright/test'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })

const PORT = 3010
const baseURL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `next dev -p ${PORT}`,
    url: `${baseURL}/auth/signin`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: (() => {
        const url = process.env.TEST_DATABASE_URL
        if (!url) throw new Error('TEST_DATABASE_URL must be set for Playwright')
        return url
      })(),
      SESSION_SECRET:
        process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
          ? process.env.SESSION_SECRET
          : 'test_session_secret_at_least_32_characters_long_!!',
      APP_URL: baseURL,
      RESEND_API_KEY: '',
      R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID ?? '',
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? '',
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? '',
      R2_BUCKET: process.env.R2_BUCKET ?? '',
    },
  },
})
