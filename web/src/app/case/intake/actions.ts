'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { executeAiTask } from '@/lib/ai/gateway'
import { getOrCreateCase } from '@/lib/cases'
import { serviceFactsSchema, saveServiceFacts, confirmServiceFacts } from '@/lib/facts'

const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES = 15 * 1024 * 1024

/** Upload a separation document, extract facts with AI, save them UNCONFIRMED. */
export async function uploadAndExtract(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const file = formData.get('document')
  if (!(file instanceof File) || file.size === 0) {
    redirect('/case/intake?error=' + encodeURIComponent('Choose a file to upload'))
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    redirect('/case/intake?error=' + encodeURIComponent('PDF, JPEG, PNG, or WebP only'))
  }
  if (file.size > MAX_BYTES) {
    redirect('/case/intake?error=' + encodeURIComponent('File too large (15 MB max)'))
  }

  const c = await getOrCreateCase()
  const bytes = Buffer.from(await file.arrayBuffer())

  // Durable record first (path convention {user}/{case}/{file} — enforced by storage RLS).
  // file.name is client-controlled: strip anything that isn't a safe key character so
  // slashes/'..' can't produce odd keys (RLS already pins the {user} prefix regardless).
  const safeName = file.name.replace(/[^\w.\-]/g, '_')
  const path = `${user!.id}/${c.id}/${crypto.randomUUID()}-${safeName}`
  const { error: upErr } = await supabase.storage
    .from('case-documents')
    .upload(path, bytes, { contentType: file.type })
  if (upErr) {
    redirect('/case/intake?error=' + encodeURIComponent('Upload failed; try again'))
  }

  // Extraction is a bounded task; the result only PREFILLS the review form.
  const result = await executeAiTask(supabase, user!.id, 'extract_service_facts', {
    documentBase64: bytes.toString('base64'),
    mediaType: file.type,
  })
  if (!result.ok) {
    redirect('/case/intake?error=' + encodeURIComponent(
      result.byokKeyRejected
        ? 'Your AI provider rejected your API key — check it in AI settings, or enter your facts below'
        : 'Could not read the document automatically — enter your facts below',
    ))
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
  if (parsed.success) {
    await saveServiceFacts(c.id, parsed.data, { source: 'extracted' })
    redirect('/case/intake?extracted=1')
  }
  redirect('/case/intake?partial=1')
}

/** The human-confirmation gate: the veteran reviews and submits the final facts. */
export async function confirmFacts(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const c = await getOrCreateCase()
  const parsed = serviceFactsSchema.safeParse({
    branch: String(formData.get('branch') ?? ''),
    dischargeDate: String(formData.get('dischargeDate') ?? ''),
    characterization: String(formData.get('characterization') ?? ''),
    wasGeneralCourtMartial: formData.get('wasGeneralCourtMartial') === 'on',
  })
  if (!parsed.success) {
    redirect('/case/intake?error=' + encodeURIComponent('Check the highlighted fields'))
  }

  // Provenance is derived inside the gate: confirming the extracted values
  // untouched keeps source 'extracted'; any edit records 'manual'.
  await confirmServiceFacts(c.id, parsed.data)
  redirect('/case')
}
