import { expect, test } from 'vitest'
import { safeNext } from '@/lib/auth/redirect'

test('accepts same-origin relative paths', () => {
  expect(safeNext('/')).toBe('/')
  expect(safeNext('/events/123/join')).toBe('/events/123/join')
})

test('rejects protocol-relative and absolute URLs', () => {
  expect(safeNext('//evil.com')).toBeNull()
  expect(safeNext('/\\evil.com')).toBeNull()
  expect(safeNext('http://evil.com')).toBeNull()
  expect(safeNext('https://evil.com')).toBeNull()
})

test('rejects non-strings, empty, and oversized values', () => {
  expect(safeNext(undefined)).toBeNull()
  expect(safeNext(null)).toBeNull()
  expect(safeNext(123)).toBeNull()
  expect(safeNext('')).toBeNull()
  expect(safeNext('/'.repeat(513))).toBeNull()
})

test('rejects paths not starting with /', () => {
  expect(safeNext('events/x')).toBeNull()
  expect(safeNext('javascript:alert(1)')).toBeNull()
})
