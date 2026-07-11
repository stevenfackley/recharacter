import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { getTask, TASKS } from '@/lib/ai/tasks'

describe('task registry', () => {
  test('unknown task returns undefined (route will 404)', () => {
    expect(getTask('draft_anything_you_want')).toBeUndefined()
  })

  test('ping task exists and validates output', () => {
    const ping = getTask('ping')!
    expect(ping.model).toBe('claude-opus-4-8')
    const parsed = ping.outputSchema.safeParse({ ok: true, echo: 'hello' })
    expect(parsed.success).toBe(true)
    expect(ping.outputSchema.safeParse({ nope: 1 }).success).toBe(false)
  })

  test('every task declares the bounded-call contract', () => {
    for (const task of Object.values(TASKS)) {
      expect(task.system.length).toBeGreaterThan(0)
      expect(task.maxTokens).toBeGreaterThan(0)
      expect(task.jsonSchema.additionalProperties).toBe(false)
    }
  })

  test('ping buildPrompt validates its input', () => {
    const ping = getTask('ping')!
    expect(() => ping.buildPrompt({ message: 42 })).toThrow()
    expect(ping.buildPrompt({ message: 'hi' })).toContain('hi')
  })

  test('jsonSchema never drifts from the Zod outputSchema (structural pin)', () => {
    // outputSchema (Zod, validates responses) and jsonSchema (hand-written, sent to
    // the API as output_config.format) are parallel definitions of the same shape.
    // Pin them together: top-level property names and required set must match the
    // Zod shape exactly, for EVERY registered task.
    for (const task of Object.values(TASKS)) {
      const zodKeys = Object.keys((task.outputSchema as z.ZodObject<z.ZodRawShape>).shape).sort()
      const props = Object.keys((task.jsonSchema.properties ?? {}) as Record<string, unknown>).sort()
      const required = (((task.jsonSchema.required ?? []) as string[])).slice().sort()

      expect(props, `task ${task.name}: jsonSchema.properties drifted`).toEqual(zodKeys)
      expect(required, `task ${task.name}: jsonSchema.required drifted`).toEqual(zodKeys)
    }
  })

  test('extract_service_facts builds document content blocks', () => {
    const extract = getTask('extract_service_facts')!
    const content = extract.buildPrompt({
      documentBase64: 'aGVsbG8=',
      mediaType: 'application/pdf',
    }) as Array<Record<string, unknown>>

    expect(Array.isArray(content)).toBe(true)
    const doc = content.find((b) => b.type === 'document') as Record<string, unknown>
    expect((doc.source as Record<string, unknown>).data).toBe('aGVsbG8=')
    expect(content.some((b) => b.type === 'text')).toBe(true)
  })

  test('extract_service_facts uses an image block for images', () => {
    const extract = getTask('extract_service_facts')!
    const content = extract.buildPrompt({
      documentBase64: 'aGVsbG8=',
      mediaType: 'image/jpeg',
    }) as Array<Record<string, unknown>>
    expect(content.some((b) => b.type === 'image')).toBe(true)
    expect(content.some((b) => b.type === 'document')).toBe(false)
  })

  test('extract_service_facts output allows nulls for unreadable fields', () => {
    const extract = getTask('extract_service_facts')!
    const parsed = extract.outputSchema.safeParse({
      branch: null, dischargeDate: null, characterization: null,
      wasGeneralCourtMartial: null, notes: 'document illegible',
    })
    expect(parsed.success).toBe(true)
  })

  test('coaching_note validates its structured input', () => {
    const coaching = getTask('coaching_note')!
    expect(() => coaching.buildPrompt({ score: 'high' })).toThrow()
    const prompt = coaching.buildPrompt({
      score: 35, band: 'building',
      topGapLabel: 'Nexus letter from a mental-health clinician',
      collectedLabels: ['DD-214'],
    }) as string
    expect(prompt).toContain('35')
    expect(prompt).toContain('Nexus letter')
  })

  test('coaching_note output is a bounded note', () => {
    const coaching = getTask('coaching_note')!
    expect(coaching.outputSchema.safeParse({ note: 'Keep going.' }).success).toBe(true)
    expect(coaching.outputSchema.safeParse({ advice: 'sue them' }).success).toBe(false)
  })

  test('shape_nexus_answer validates input and embeds the narrative', () => {
    const shape = getTask('shape_nexus_answer')!
    expect(() => shape.buildPrompt({ questionKey: 'q9', rawNarrative: 'x' })).toThrow()
    const prompt = shape.buildPrompt({
      questionKey: 'q3',
      questionPrompt: 'How did it connect to the conduct that led to your discharge?',
      rawNarrative: 'I was being threatened daily and stopped sleeping...',
    }) as string
    expect(prompt).toContain('threatened daily')
  })

  test('shape_nexus_answer output shape', () => {
    const shape = getTask('shape_nexus_answer')!
    expect(shape.outputSchema.safeParse({
      shapedAnswer: 'During my second year...', gaps: 'Consider adding dates.',
    }).success).toBe(true)
  })

  test('draft_statement requires all four answers', () => {
    const draft = getTask('draft_statement')!
    expect(() => draft.buildPrompt({
      answers: { q1_condition: 'a', q2_during_service: 'b', q3_mitigation: 'c' },
    })).toThrow()
  })

  test('draft_statement with no collected evidence must not imply enclosures', () => {
    // 'listed separately' made the model write "I have included evidence with
    // this petition" for a veteran with nothing collected (2026-07-11 eval).
    const draft = getTask('draft_statement')!
    const prompt = draft.buildPrompt({
      answers: { q1_condition: 'a', q2_during_service: 'b', q3_mitigation: 'c', q4_outweigh: 'd' },
      branch: 'Army', characterization: 'OtherThanHonorable',
      dischargeDate: '2011-06-14', collectedEvidence: [],
    }) as string
    expect(prompt).toContain('Evidence being included: none yet.')
    expect(prompt).not.toContain('listed separately')
    expect(draft.system).toContain('never say evidence is included, enclosed, or attached')
  })

  test('exactly the premium trio is gated behind the freemium boundary', () => {
    // Pins against accidental gating/ungating: intake extraction (acquisition cost),
    // coaching_note, and ping stay free; the three AI-drafting surfaces are premium.
    const premiumNames = Object.values(TASKS)
      .filter((t) => t.premium)
      .map((t) => t.name)
      .sort()
    expect(premiumNames).toEqual(['draft_cover_letter', 'draft_statement', 'shape_nexus_answer'])
  })

  test('draft_cover_letter embeds board and form', () => {
    const cover = getTask('draft_cover_letter')!
    const prompt = cover.buildPrompt({
      boardName: 'NDRB', form: 'DD293',
      branch: 'MarineCorps', characterization: 'OtherThanHonorable',
      conditionSummary: 'adjustment disorder arising in service',
    }) as string
    expect(prompt).toContain('NDRB')
    expect(prompt).toContain('DD293')
  })
})
