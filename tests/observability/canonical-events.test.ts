/**
 * CI audit: every canonical event name that operators use in runbooks MUST
 * appear at least once in the TypeScript source tree (lib/, app/, scripts/).
 *
 * If a refactor renames `worker.dispatch.success` → `worker.dispatch.successful`
 * this test will fail and CI will catch the drift before it reaches production.
 *
 * This is a smoke test — it proves the string exists somewhere in the source,
 * not that every code-path emits it. Exhaustive emission coverage lives in the
 * unit tests for each module (complete.test.ts, dispatcher.test.ts, etc.).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// ─── helpers ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../..')

/** Recursively collect all .ts / .tsx files under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip node_modules and .next output
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      out.push(...collectTsFiles(full))
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const SEARCH_DIRS = ['lib', 'app', 'scripts'].map((d) => path.join(ROOT, d))

/** Concatenated source of all TS files in the search dirs. */
function readCorpus(): string {
  const files = SEARCH_DIRS.flatMap((d) => {
    try {
      return collectTsFiles(d)
    } catch {
      return []
    }
  })
  return files.map((f) => fs.readFileSync(f, 'utf-8')).join('\n')
}

// ─── canonical event names from the Phase-3 spec ─────────────────────────
//
// Source: plan lines 638-654, cross-referenced with grep inventory.
// Each name maps to a "Failure visibility" requirement; renaming any of these
// without updating the runbook will break on-call alerting.

const CANONICAL_EVENTS = [
  // Task 4
  'photo_job.enqueue',
  'worker.enqueue.failed',
  // Task 5
  'worker.job.reclaimed',
  // Task 6
  'worker.job.failed',
  'worker.job.retry',
  // Task 9
  'worker.dispatch.success',
  'worker.dispatch.retry',
  'worker.dispatch.dead_letter',
  // Task 10
  'worker.runner.started',
  'worker.runner.shutting_down',
  'worker.runner.idle',
  'worker.watchdog.reclaimed',
  // Task 12
  'worker.cluster.run_completed',
  'worker.cluster.failed',
]

// ─── test ─────────────────────────────────────────────────────────────────

/**
 * Match the event name as a quoted string literal: either 'event.name' or
 * "event.name". This prevents false positives from substring matches —
 * e.g. 'worker.dispatch.successful' must NOT satisfy the 'worker.dispatch.success' check.
 */
function eventIsPresent(corpus: string, eventName: string): boolean {
  // Escape dots for regex
  const escaped = eventName.replace(/\./g, '\\.')
  const re = new RegExp(`['"]${escaped}['"]`)
  return re.test(corpus)
}

describe('canonical event audit (TS)', () => {
  const corpus = readCorpus()

  it.each(CANONICAL_EVENTS)(
    'event "%s" appears in lib/app/scripts source',
    (eventName) => {
      expect(
        eventIsPresent(corpus, eventName),
        `Event '${eventName}' not found as a quoted string literal in lib/, app/, or scripts/. ` +
          `Check that the emitting code was not accidentally renamed.`,
      ).toBe(true)
    },
  )
})
