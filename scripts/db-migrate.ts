#!/usr/bin/env tsx
/**
 * Wrapper around `drizzle-kit migrate` that tolerates a known drizzle-kit 0.31.x
 * quirk: when the DB is already up-to-date, the postgres.js driver emits NOTICE
 * rows for the internal `drizzle` schema + `__drizzle_migrations` table
 * (created with IF NOT EXISTS), and drizzle-kit's spinner treats those notices
 * as a failure — exiting 1 with no actual migration error. This bites every
 * fresh contributor whose persistent Docker volume survived a container restart.
 *
 * Strategy:
 *   1. Snapshot the migration ledger before invoking drizzle-kit.
 *   2. Run drizzle-kit, capturing stdout/stderr while still streaming.
 *   3. If exit is non-zero, only swallow it when ALL of:
 *        a. The captured output contains no error markers, only benign
 *           "already exists" NOTICE blocks (codes 42P06 / 42P07).
 *        b. The post-run ledger has *exactly* as many applied entries as the
 *           on-disk journal (`db/migrations/meta/_journal.json`). This guards
 *           against silently masking a genuine half-applied migration.
 *
 * Any real failure (failed migration SQL, connection refused, unapplied
 * pending migrations) still propagates exit 1 with full output.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import postgres from 'postgres'

const NOTICE_CODES = new Set(['42P06', '42P07']) // schema/relation already exists

loadEnv({ path: '.env.local' })
loadEnv({ path: '.env' })

function readExpectedMigrationCount(): number {
  const journalPath = resolve(process.cwd(), 'db/migrations/meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: unknown[]
  }
  return journal.entries.length
}

async function readAppliedMigrationCount(): Promise<number | null> {
  const url = process.env.DATABASE_URL
  if (!url) return null
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM drizzle.__drizzle_migrations
    `
    return Number(rows[0]?.count ?? 0)
  } catch {
    // Table doesn't exist yet, or DB unreachable — treat as unknown
    return null
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function isBenignNoticeOutput(output: string): boolean {
  // Strip ANSI + spinner control codes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control sequences
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')

  const noticeBlocks = clean.match(/\{[^{}]*severity:\s*'NOTICE'[^{}]*\}/g) ?? []
  if (noticeBlocks.length === 0) return false

  for (const block of noticeBlocks) {
    const m = block.match(/code:\s*'([^']+)'/)
    if (!m || !NOTICE_CODES.has(m[1]!)) return false
  }

  const residue = clean
    .replace(/\{[^{}]*severity:\s*'NOTICE'[^{}]*\}/g, '')
    .replace(/Command failed with exit code 1\.?/g, '')
  if (/\berror\b/i.test(residue)) return false
  if (/\bfailed\b/i.test(residue)) return false
  return true
}

async function main() {
  const expected = readExpectedMigrationCount()

  const child = spawn('drizzle-kit', ['migrate'], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    const s = chunk.toString()
    stdout += s
    process.stdout.write(s)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString()
    stderr += s
    process.stderr.write(s)
  })

  const code: number = await new Promise((resolveExit) => {
    child.on('close', (c) => resolveExit(c ?? 0))
  })

  if (code === 0) {
    process.exit(0)
  }

  const combined = `${stdout}\n${stderr}`
  const benign = isBenignNoticeOutput(combined)
  const applied = await readAppliedMigrationCount()

  if (benign && applied !== null && applied === expected) {
    console.log(
      `\n[db:migrate] drizzle-kit exited ${code} but DB is up-to-date ` +
        `(${applied}/${expected} migrations applied) and output only ` +
        `contained benign "already exists" NOTICEs — treating as success.`,
    )
    process.exit(0)
  }

  if (applied !== null && applied < expected) {
    console.error(
      `\n[db:migrate] drizzle-kit exited ${code} with ${applied}/${expected} ` +
        `migrations applied. This is a real failure — not swallowing it.`,
    )
  }
  process.exit(code)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
