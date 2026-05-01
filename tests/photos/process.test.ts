import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import exifr from 'exifr'
import sharp from 'sharp'
import { describe, expect, test } from 'vitest'
import { ImageProcessError, processImage } from '@/lib/photos/process'

const FIX = join(__dirname, '../fixtures/photos')

describe('processImage', () => {
  test('JPEG round-trip outputs decodable JPEG with width/height', async () => {
    const buf = readFileSync(join(FIX, 'plain.jpg'))
    const out = await processImage(buf)

    expect(out.width).toBe(800)
    expect(out.height).toBe(600)

    const orig = await sharp(out.originalJpeg).metadata()
    expect(orig.format).toBe('jpeg')
    expect(orig.width).toBe(800)
    const prev = await sharp(out.previewJpeg).metadata()
    expect(prev.format).toBe('jpeg')
    expect(Math.max(prev.width ?? 0, prev.height ?? 0)).toBeLessThanOrEqual(2048)
  })

  test('preview is downsized when source > 2048 on long edge', async () => {
    const big = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer()
    const out = await processImage(big)
    const prev = await sharp(out.previewJpeg).metadata()
    expect(Math.max(prev.width ?? 0, prev.height ?? 0)).toBe(2048)
  })

  test('EXIF orientation=6 input is rotated upright in output', async () => {
    const buf = readFileSync(join(FIX, 'rotated-orientation-6.jpg'))
    const out = await processImage(buf)
    // Source was created as 800x600 with orientation=6 (90° CW), so the
    // upright output should be 600 wide × 800 tall.
    expect(out.width).toBe(600)
    expect(out.height).toBe(800)
  })

  test('GPS is stripped from output', async () => {
    const buf = readFileSync(join(FIX, 'with-gps.jpg'))
    const out = await processImage(buf)
    const exifOrig = await exifr.gps(out.originalJpeg)
    const exifPrev = await exifr.gps(out.previewJpeg)
    expect(exifOrig).toBeUndefined()
    expect(exifPrev).toBeUndefined()
  })

  test('takenAt is extracted when DateTimeOriginal present', async () => {
    const withDate = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withExif({ IFD2: { DateTimeOriginal: '2026:04:15 14:30:00' } })
      .jpeg({ quality: 90 })
      .toBuffer()
    const out = await processImage(withDate)
    expect(out.takenAt?.toISOString()).toBe('2026-04-15T14:30:00.000Z')
  })

  test('takenAt is null when EXIF absent', async () => {
    const buf = readFileSync(join(FIX, 'plain.jpg'))
    const out = await processImage(buf)
    expect(out.takenAt).toBeNull()
  })

  test('corrupt input throws ImageProcessError', async () => {
    await expect(processImage(Buffer.from('not an image'))).rejects.toBeInstanceOf(
      ImageProcessError,
    )
  })
})
