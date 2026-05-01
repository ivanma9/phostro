import exifr from 'exifr'
import sharp from 'sharp'

export class ImageProcessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageProcessError'
  }
}

export type ProcessImageResult = {
  originalJpeg: Buffer
  previewJpeg: Buffer
  width: number
  height: number
  takenAt: Date | null
}

const PREVIEW_LONG_EDGE = 2048
const ORIGINAL_QUALITY = 95
const PREVIEW_QUALITY = 85

export async function processImage(buf: Buffer): Promise<ProcessImageResult> {
  // Parse EXIF before sharp because .rotate().withMetadata({}) wipes EXIF.
  // Use reviveValues: false to get the raw EXIF string, then interpret as UTC
  // (EXIF has no timezone — cameras record local time without offset).
  let takenAt: Date | null = null
  try {
    const exif = await exifr
      .parse(buf, { pick: ['DateTimeOriginal'], reviveValues: false })
      .catch(() => null)
    const raw = exif?.DateTimeOriginal
    if (typeof raw === 'string' && raw.length >= 19) {
      // EXIF format: 'YYYY:MM:DD HH:MM:SS' → 'YYYY-MM-DD HH:MM:SS'
      const iso = `${raw.slice(0, 10).replace(/:/g, '-') + raw.slice(10)}Z`
      const parsed = new Date(iso)
      if (!Number.isNaN(parsed.getTime())) takenAt = parsed
    }
  } catch {
    takenAt = null
  }

  // .rotate() (no args) auto-rotates by EXIF orientation and consumes the tag.
  // Encode + read upright dimensions from the output info; sharp throws on corrupt input.
  try {
    const upright = sharp(buf, { failOn: 'truncated' }).rotate()
    const original = await upright
      .clone()
      .jpeg({ quality: ORIGINAL_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })

    const previewJpeg = await upright
      .clone()
      .resize({
        width: PREVIEW_LONG_EDGE,
        height: PREVIEW_LONG_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: PREVIEW_QUALITY, mozjpeg: true })
      .toBuffer()

    if (!original.info.width || !original.info.height) {
      throw new ImageProcessError('image has no dimensions')
    }

    return {
      originalJpeg: original.data,
      previewJpeg,
      width: original.info.width,
      height: original.info.height,
      takenAt,
    }
  } catch (e) {
    if (e instanceof ImageProcessError) throw e
    throw new ImageProcessError('failed to decode image', { cause: e })
  }
}
