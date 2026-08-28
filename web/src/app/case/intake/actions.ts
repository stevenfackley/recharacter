'use server'

import { redirect } from 'next/navigation'
import { requireSessionUser } from '@/lib/session'
import { executeAiTask } from '@/lib/ai/gateway'
import { getOrCreateCase } from '@/lib/cases'
import { getObjectStore } from '@/lib/storage'
import {
  putCaseDocument, DocumentTooLargeError, UnsupportedDocumentError,
  type DocumentType,
} from '@/lib/case-documents'
import { serviceFactsSchema, saveServiceFacts, confirmServiceFacts } from '@/lib/facts'

/**
 * Failures leave through `?error=<code>` only; the copy lives on the page. A URL
 * that carries its own message is a place for someone else to put words on
 * recharacter.us — the same rule lib/auth-errors.ts enforces for the auth pages.
 */

/** Upload a separation document, extract facts with AI, save them UNCONFIRMED. */
export async function uploadAndExtract(formData: FormData) {
  const user = await requireSessionUser('/case/intake')

  const file = formData.get('document')
  if (!(file instanceof File) || file.size === 0) {
    redirect('/case/intake?error=no_file')
  }

  const c = await getOrCreateCase(user.id)
  const bytes = new Uint8Array(await file.arrayBuffer())

  // Durable record first. Size, type and key are all the store's decision: the
  // multipart Content-Type is client-controlled, so the SNIFFED type is what the
  // extraction task is told about — never file.type.
  let stored: { key: string; contentType: DocumentType }
  try {
    stored = await putCaseDocument(getObjectStore(), user.id, c.id, file.name, bytes)
  } catch (err) {
    if (err instanceof DocumentTooLargeError) redirect('/case/intake?error=file_too_large')
    if (err instanceof UnsupportedDocumentError) redirect('/case/intake?error=unsupported_file')
    console.error('case document upload failed:', err instanceof Error ? err.message : err)
    redirect('/case/intake?error=upload_failed')
  }

  // Extraction is a bounded task; the result only PREFILLS the review form.
  const result = await executeAiTask(user.id, 'extract_service_facts', {
    documentBase64: Buffer.from(bytes).toString('base64'),
    mediaType: stored.contentType,
  })
  if (!result.ok) {
    redirect(result.byokKeyRejected
      ? '/case/intake?error=byok_key_rejected'
      : '/case/intake?error=extract_failed')
  }

  const d = result.data as {
    branch: string | null; dischargeDate: string | null
    characterization: string | null; wasGeneralCourtMartial: boolean | null
  }

  // Save only if extraction produced a COMPLETE, valid fact set (unconfirmed —
  // the veteran must review). For PARTIAL extractions we deliberately do NOT
  // forward the fields through query params: characterization/discharge date are
  // stigmatizing personal data and query strings land in server logs, browser
  // history, and Referer headers. The veteran re-enters what we couldn't read.
  // (Future: persist partials server-side as an unconfirmed draft.)
  const candidate = {
    branch: d.branch, dischargeDate: d.dischargeDate,
    characterization: d.characterization,
    wasGeneralCourtMartial: d.wasGeneralCourtMartial ?? false,
  }
  const parsed = serviceFactsSchema.safeParse(candidate)
  if (!parsed.success) redirect('/case/intake?partial=1')

  try {
    await saveServiceFacts(user.id, c.id, parsed.data, 'extracted')
  } catch (err) {
    // The failure message only — never the facts themselves.
    console.error('service facts save failed:', err instanceof Error ? err.message : err)
    redirect('/case/intake?error=save_failed')
  }
  redirect('/case/intake?extracted=1')
}

/** The human-confirmation gate: the veteran reviews and submits the final facts. */
export async function confirmFacts(formData: FormData) {
  const user = await requireSessionUser('/case/intake')

  const c = await getOrCreateCase(user.id)
  const parsed = serviceFactsSchema.safeParse({
    branch: String(formData.get('branch') ?? ''),
    dischargeDate: String(formData.get('dischargeDate') ?? ''),
    characterization: String(formData.get('characterization') ?? ''),
    wasGeneralCourtMartial: formData.get('wasGeneralCourtMartial') === 'on',
  })
  if (!parsed.success) {
    redirect('/case/intake?error=invalid_facts')
  }

  // Provenance is derived inside the gate: confirming the extracted values
  // untouched keeps source 'extracted'; any edit records 'manual'.
  try {
    await confirmServiceFacts(user.id, c.id, parsed.data)
  } catch (err) {
    console.error('service facts confirm failed:', err instanceof Error ? err.message : err)
    redirect('/case/intake?error=save_failed')
  }
  redirect('/case')
}
