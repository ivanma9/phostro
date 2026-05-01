export function pendingKey(eventId: string, photoId: string): string {
  return `events/${eventId}/pending/${photoId}.bin`
}

export function originalKey(eventId: string, photoId: string): string {
  return `events/${eventId}/original/${photoId}.jpg`
}

export function previewKey(eventId: string, photoId: string): string {
  return `events/${eventId}/preview/${photoId}.jpg`
}

export const ALLOWED_UPLOAD_MIMES = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif'])

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const MAX_PHOTOS_PER_EVENT = 5000
export const PUT_URL_TTL_SECONDS = 15 * 60
