import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

const DIR = join(__dirname, 'fixtures/photos')

async function gen() {
  if (existsSync(join(DIR, 'plain.jpg'))) return
  mkdirSync(DIR, { recursive: true })

  // 1. Plain JPEG, 800x600, blue
  const plain = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 50, g: 100, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
  writeFileSync(join(DIR, 'plain.jpg'), plain)

  // 2. JPEG with EXIF orientation = 6 (rotated 90° CW). withMetadata({orientation})
  // is the only sharp API that actually embeds the orientation tag in libvips 8.17.
  const rotated = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 50, b: 100 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toBuffer()
  writeFileSync(join(DIR, 'rotated-orientation-6.jpg'), rotated)

  // 3. JPEG with GPS in EXIF
  const withGps = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 200, b: 50 } },
  })
    .withExif({
      GPS: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '37/1, 46/1, 30/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '122/1, 25/1, 10/1',
      },
    })
    .jpeg({ quality: 90 })
    .toBuffer()
  writeFileSync(join(DIR, 'with-gps.jpg'), withGps)

  // 4. HEIC built from JPEG bytes (Sharp 0.34+ supports HEIF encode via libheif)
  try {
    const heic = await sharp(plain).heif({ quality: 60, compression: 'hevc' }).toBuffer()
    writeFileSync(join(DIR, 'plain.heic'), heic)
  } catch {
    // Some Sharp builds ship without HEIF encode. In that case, fall back to copying the JPEG
    // so HEIC-decode tests can be skipped instead of breaking. The HEIC test is gated below.
    writeFileSync(join(DIR, 'plain.heic'), plain)
  }
}

export default gen
