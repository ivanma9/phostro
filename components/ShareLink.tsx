'use client'

import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'

export function ShareLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div className="mt-4 space-y-3">
      <input readOnly value={url} className="w-full rounded border px-3 py-2 text-sm" />
      <button
        type="button"
        onClick={copy}
        className="rounded bg-black px-4 py-2 text-sm text-white"
      >
        {copied ? 'Copied!' : 'Copy link'}
      </button>
      <div className="pt-2">
        <QRCodeSVG value={url} size={200} />
      </div>
    </div>
  )
}
