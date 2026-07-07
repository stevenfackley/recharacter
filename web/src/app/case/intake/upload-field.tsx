'use client'

import { useState } from 'react'

/**
 * The DD-214 file control. A <label for> associated with the input is the most
 * battle-tested cross-browser way to open the native picker (bare file inputs
 * have click-interception quirks under overlays/styling). The input itself
 * stays in the DOM (form-submittable, keyboard-focusable) but visually hidden;
 * the label renders as the button. The chosen filename is echoed so "did that
 * work?" is never ambiguous.
 */
export function UploadField() {
  const [fileName, setFileName] = useState<string | null>(null)

  return (
    <div className="upload-field">
      <label htmlFor="document-upload" className="upload-trigger">
        Browse for your document…
      </label>
      <input
        id="document-upload"
        name="document"
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        required
        className="upload-input"
        onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
      />
      <span className="upload-name" aria-live="polite">
        {fileName ?? 'No file selected yet'}
      </span>
    </div>
  )
}
