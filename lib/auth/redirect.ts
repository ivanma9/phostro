// Validates a post-auth redirect path. Allows only same-origin relative paths
// (single leading "/" + non-slash next char). Rejects "//host", "/\\host",
// schemes ("http://"), and protocol-relative URLs.
export function safeNext(next: unknown): string | null {
  if (typeof next !== 'string') return null
  if (next.length === 0 || next.length > 512) return null
  if (next[0] !== '/') return null
  if (next[1] === '/' || next[1] === '\\') return null
  return next
}
