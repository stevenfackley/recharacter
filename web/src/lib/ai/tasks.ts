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

const shapeInput = z.object({
  questionKey: z.enum(['q1', 'q2', 'q3', 'q4']),
  questionPrompt: z.string().min(1).max(500),
  rawNarrative: z.string().min(1).max(8000),
})
const shapeOutput = z.object({
  shapedAnswer: z.string().min(1).max(6000),
  gaps: z.string().max(1000),
})

const shape_nexus_answer: AiTask = {
  name: 'shape_nexus_answer',
  model: 'claude-opus-4-8',
  system:
    'You help a veteran phrase their OWN account for one specific question a discharge review ' +
    'board weighs, inside a document-assembly application. Rewrite their raw narrative into a ' +
    'clear, first-person answer to the question. RULES: preserve their voice and their words ' +
    'wherever possible; NEVER add facts, events, dates, diagnoses, or details they did not ' +
    'state; do not exaggerate; do not give advice or legal argument. In gaps, note (one or two ' +
    'sentences, addressed to the veteran) what a reader might still wonder — phrased as ' +
    '"consider describing…", never as instructions about strategy. The veteran will edit and ' +
    'own the final text.',
  maxTokens: 2048,
  inputSchema: shapeInput,
  outputSchema: shapeOutput,
  jsonSchema: {
    type: 'object',
    properties: { shapedAnswer: { type: 'string' }, gaps: { type: 'string' } },
    required: ['shapedAnswer', 'gaps'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const { questionPrompt, rawNarrative } = shapeInput.parse(input)
    return `The question: ${questionPrompt}\n\nThe veteran's raw account:\n${rawNarrative}`
  },
}

const draftAnswers = z.object({
  q1_condition: z.string().min(1).max(6000),
  q2_during_service: z.string().min(1).max(6000),
  q3_mitigation: z.string().min(1).max(6000),
  q4_outweigh: z.string().min(1).max(6000),
})
const draftInput = z.object({
  answers: draftAnswers,
  branch: z.enum(BRANCH_VALUES),
  characterization: z.enum(CHARACTERIZATION_VALUES),
  dischargeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  collectedEvidence: z.array(z.string().max(120)).max(10),
})
const draftOutput = z.object({ statement: z.string().min(1) })

const draft_statement: AiTask = {
  name: 'draft_statement',
  model: 'claude-opus-4-8',
  system:
    'You assemble a personal statement for a veteran petitioning a discharge review board, ' +
    'inside a document-assembly application. You are given the veteran\'s four approved answers ' +
    '(their own words), their confirmed service facts, and a list of evidence they are including. ' +
    'Produce a complete first-person statement: a brief opening identifying the service and the ' +
    'characterization being petitioned; the four answers woven into a coherent narrative in ' +
    'their original order; a short closing that respectfully asks the board to apply liberal ' +
    'consideration to the mental-health evidence. RULES: the statement may contain ONLY facts ' +
    'present in the inputs — never invent events, dates, names, diagnoses, or details; preserve ' +
    'the veteran\'s voice and words wherever possible; plain language, no citations, no legal ' +
    'argument beyond the liberal-consideration request; do not address filing strategy. The ' +
    'veteran will review, edit, and own this draft.',
  maxTokens: 8192,
  inputSchema: draftInput,
  outputSchema: draftOutput,
  jsonSchema: {
    type: 'object',
    properties: { statement: { type: 'string' } },
    required: ['statement'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const d = draftInput.parse(input)
    return (
      `Service facts: branch ${d.branch}; discharged ${d.dischargeDate}; characterization ${d.characterization}.\n` +
      `Evidence being included: ${d.collectedEvidence.length ? d.collectedEvidence.join('; ') : 'listed separately'}.\n\n` +
      `Answer 1 — the condition/experience:\n${d.answers.q1_condition}\n\n` +
      `Answer 2 — during service:\n${d.answers.q2_during_service}\n\n` +
      `Answer 3 — connection to the conduct (nexus):\n${d.answers.q3_mitigation}\n\n` +
      `Answer 4 — whole record:\n${d.answers.q4_outweigh}`
    )
  },
}

const coverInput = z.object({
  boardName: z.string().min(1).max(40),
  form: z.enum(['DD293', 'DD149']),
  branch: z.enum(BRANCH_VALUES),
  characterization: z.enum(CHARACTERIZATION_VALUES),
  conditionSummary: z.string().min(1).max(300),
})
const coverOutput = z.object({ letter: z.string().min(1) })

const draft_cover_letter: AiTask = {
  name: 'draft_cover_letter',
  model: 'claude-opus-4-8',
  system:
    'You draft a short, formal cover letter for a discharge-upgrade application packet, inside ' +
    'a document-assembly application. One page maximum: addressee is the named review board; ' +
    'state the enclosed application form, the relief requested (upgrade of the characterization), ' +
    'a one-sentence summary of the mental-health basis with a respectful request for liberal ' +
    'consideration, and an enclosures line. Use placeholders in square brackets for anything not ' +
    'provided (name, address, date, signature). RULES: only facts from the input; no legal ' +
    'argument; plain, respectful, formal register. The veteran will review, edit, and own it.',
  maxTokens: 2048,
  inputSchema: coverInput,
  outputSchema: coverOutput,
  jsonSchema: {
    type: 'object',
    properties: { letter: { type: 'string' } },
    required: ['letter'],
    additionalProperties: false,
  },
  buildPrompt: (input) => {
    const d = coverInput.parse(input)
    return (
      `Board: ${d.boardName}. Form enclosed: ${d.form}. Branch: ${d.branch}. ` +
      `Current characterization: ${d.characterization}. ` +
      `Mental-health basis (one sentence): ${d.conditionSummary}.`
    )
  },
}

export const TASKS: Record<string, AiTask> = {
  ping, extract_service_facts, coaching_note,
  shape_nexus_answer, draft_statement, draft_cover_letter,
}

export function getTask(name: string): AiTask | undefined {
  return TASKS[name]
}
