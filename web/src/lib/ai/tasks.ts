import { z } from 'zod'

// Same literals as web/src/lib/facts.ts (kept independent to avoid a client/server import edge).
const BRANCH_VALUES = ['Army', 'Navy', 'MarineCorps', 'AirForce', 'SpaceForce', 'CoastGuard'] as const
const CHARACTERIZATION_VALUES = [
  'Honorable', 'GeneralUnderHonorable', 'OtherThanHonorable',
  'BadConductDischarge', 'DishonorableDischarge', 'Uncharacterized',
] as const

/**
 * Every AI call in ReCharacter is a registered, bounded task: fixed system prompt,
 * validated input, JSON-schema-constrained output. There are no free-form endpoints.
 * This is the anti-UPL boundary enforced in code — the model assembles documents and
 * extracts facts; it never gives open-ended advice.
 */
export type AiTask = {
  name: string
  model: 'claude-opus-4-8'
  system: string
  maxTokens: number
  inputSchema: z.ZodTypeAny
  outputSchema: z.ZodTypeAny
  /** JSON Schema mirror of outputSchema, sent as output_config.format (must set additionalProperties: false). */
  jsonSchema: Record<string, unknown> & { additionalProperties: false }
  /** Returns a plain string OR an array of Anthropic content blocks (vision/PDF tasks). */
  buildPrompt: (input: unknown) => string | Array<Record<string, unknown>>
}

const pingInput = z.object({ message: z.string().min(1).max(200) })
const pingOutput = z.object({ ok: z.boolean(), echo: z.string() })

const ping: AiTask = {
  name: 'ping',
  model: 'claude-opus-4-8',
  system:
    'You are the connectivity check for a document-assembly application. ' +
    'Respond only with the JSON the schema requires. Set ok to true and echo the message verbatim.',
  maxTokens: 256,
  inputSchema: pingInput,
  outputSchema: pingOutput,
  jsonSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, echo: { type: 'string' } },
    required: ['ok', 'echo'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const { message } = pingInput.parse(input)
    return `Echo this message back: ${message}`
  },
}

const extractInput = z.object({
  // ~15 MB base64-inflated: the task boundary enforces its own cap so callers
  // bypassing the upload action's limit still can't trigger an unbounded call.
  documentBase64: z.string().min(1).max(21_000_000),
  mediaType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  notes: z.string().max(2000).optional(),
})

const extractOutput = z.object({
  branch: z.enum(BRANCH_VALUES).nullable(),
  dischargeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  characterization: z.enum(CHARACTERIZATION_VALUES).nullable(),
  wasGeneralCourtMartial: z.boolean().nullable(),
  notes: z.string(),
})

const extract_service_facts: AiTask = {
  name: 'extract_service_facts',
  model: 'claude-opus-4-8',
  system:
    'You extract structured facts from a US military separation document (typically a DD-214) ' +
    'for a document-assembly application. Read the document and report ONLY what it states. ' +
    'If a field is not clearly present, return null for it — never guess or infer. ' +
    'branch: the service branch. dischargeDate: the separation date (ISO YYYY-MM-DD). ' +
    'characterization: the character of service exactly as one of the allowed values. ' +
    'wasGeneralCourtMartial: true only if the document shows the discharge resulted from a ' +
    'general court-martial. notes: one or two sentences on anything ambiguous or unreadable. ' +
    'You provide no advice or opinions of any kind.',
  maxTokens: 2048,
  inputSchema: extractInput,
  outputSchema: extractOutput,
  jsonSchema: {
    type: 'object',
    properties: {
      branch: { anyOf: [{ type: 'null' }, { type: 'string', enum: [...BRANCH_VALUES] }] },
      dischargeDate: { anyOf: [{ type: 'null' }, { type: 'string' }] },
      characterization: { anyOf: [{ type: 'null' }, { type: 'string', enum: [...CHARACTERIZATION_VALUES] }] },
      wasGeneralCourtMartial: { anyOf: [{ type: 'null' }, { type: 'boolean' }] },
      notes: { type: 'string' },
    },
    required: ['branch', 'dischargeDate', 'characterization', 'wasGeneralCourtMartial', 'notes'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const { documentBase64, mediaType, notes } = extractInput.parse(input)
    const source = { type: 'base64', media_type: mediaType, data: documentBase64 }
    const docBlock =
      mediaType === 'application/pdf'
        ? { type: 'document', source }
        : { type: 'image', source }
    return [
      docBlock,
      {
        type: 'text',
        text:
          'Extract the service facts from this document.' +
          (notes ? ` Context from the veteran (facts in the document still win): ${notes}` : ''),
      },
    ]
  },
}

const coachingInput = z.object({
  score: z.number().int().min(0).max(100),
  band: z.enum(['building', 'developing', 'strong']),
  topGapLabel: z.string().nullable(),
  collectedLabels: z.array(z.string()).max(10),
})

const coachingOutput = z.object({ note: z.string().min(1).max(800) })

const coaching_note: AiTask = {
  name: 'coaching_note',
  model: 'claude-opus-4-8',
  system:
    'You write a short, warm, plain-English encouragement note for a veteran assembling ' +
    'evidence for a discharge-upgrade petition, inside a document-assembly application. ' +
    'You are given a completeness score, its band, what they have collected, and the single ' +
    'highest-value missing item. Write 2-3 sentences: acknowledge progress specifically, then ' +
    'point at the one next step. Never predict outcomes, never give legal advice or strategy, ' +
    'never mention lawyers or deadlines. The note is informational encouragement only.',
  maxTokens: 512,
  inputSchema: coachingInput,
  outputSchema: coachingOutput,
  jsonSchema: {
    type: 'object',
    properties: { note: { type: 'string' } },
    required: ['note'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const { score, band, topGapLabel, collectedLabels } = coachingInput.parse(input)
    return (
      `Completeness score: ${score}/100 (${band}). ` +
      `Collected so far: ${collectedLabels.length ? collectedLabels.join('; ') : 'nothing yet'}. ` +
      `Highest-value missing item: ${topGapLabel ?? 'none — everything applicable is collected'}.`
    )
  },
}

export const TASKS: Record<string, AiTask> = { ping, extract_service_facts, coaching_note }

export function getTask(name: string): AiTask | undefined {
  return TASKS[name]
}
