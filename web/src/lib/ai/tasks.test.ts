import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { getTask, TASKS } from '@/lib/ai/tasks'

describe('task registry', () => {
  test('unknown task returns undefined (route will 404)', () => {
    expect(getTask('draft_anything_you_want')).toBeUndefined()
  })

  test('inherited object properties are not tasks', () => {
    // A prototype walk would hand back Object.prototype's members as if they
    // were registered tasks; the gateway would then call buildPrompt on one.
    expect(getTask('constructor')).toBeUndefined()
    expect(getTask('toString')).toBeUndefined()
    expect(getTask('__proto__')).toBeUndefined()
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

  test('the branch and characterization sets each schema accepts are exactly the RulesEngine values', () => {
    const BRANCHES = ['Army', 'Navy', 'MarineCorps', 'AirForce', 'SpaceForce', 'CoastGuard']
    const CHARACTERIZATIONS = [
      'Honorable', 'GeneralUnderHonorable', 'OtherThanHonorable',
      'BadConductDischarge', 'DishonorableDischarge', 'Uncharacterized',
    ]
    const enumOf = (schema: z.ZodTypeAny, key: string) => {
      let field = (schema as z.ZodObject<z.ZodRawShape>).shape[key] as z.ZodTypeAny
      if (field instanceof z.ZodNullable) field = field.unwrap() as z.ZodTypeAny
      return (field as z.ZodEnum).options
    }
    const extract = getTask('extract_service_facts')!.outputSchema
    const statement = getTask('draft_statement')!.inputSchema
    const cover = getTask('draft_cover_letter')!.inputSchema
    for (const schema of [extract, statement, cover]) {
      expect(enumOf(schema, 'branch')).toEqual(BRANCHES)
      expect(enumOf(schema, 'characterization')).toEqual(CHARACTERIZATIONS)
    }
    const sent = getTask('extract_service_facts')!.jsonSchema.properties as Record<string, { anyOf: Array<{ enum?: string[] }> }>
    expect(sent.branch.anyOf[1].enum).toEqual(BRANCHES)
    expect(sent.characterization.anyOf[1].enum).toEqual(CHARACTERIZATIONS)
  })

  test('whole-registry pin: every task\'s contract as sent to the model', () => {
    // One recorded document per task: the system prompt, the JSON schema sent
    // as output_config.format, and the prompt built from a representative
    // (fake) input. Any change to what the model is told shows up here. (The
    // Zod schemas are pinned by behaviour in the tests around this one, not by
    // a rendering that would churn with every Zod release.)
    const SAMPLE_INPUTS: Record<string, unknown> = {
      ping: { message: 'fixture ping' },
      extract_service_facts: { documentBase64: 'Rml4dHVyZQ==', mediaType: 'image/png', notes: 'fixture note' },
      coaching_note: { score: 40, band: 'developing', topGapLabel: 'Fixture gap', collectedLabels: ['Fixture A', 'Fixture B'] },
      shape_nexus_answer: { questionKey: 'q2', questionPrompt: 'Fixture question?', rawNarrative: 'Fixture narrative.' },
      draft_statement: {
        answers: { q1_condition: 'Fixture 1', q2_during_service: 'Fixture 2', q3_mitigation: 'Fixture 3', q4_outweigh: 'Fixture 4' },
        branch: 'SpaceForce', characterization: 'BadConductDischarge', dischargeDate: '2001-02-03',
        collectedEvidence: ['Fixture evidence'],
      },
      draft_cover_letter: {
        boardName: 'Fixture Board', form: 'DD149', branch: 'CoastGuard',
        characterization: 'Uncharacterized', conditionSummary: 'a fixture condition arising during service',
      },
    }
    expect(Object.keys(TASKS)).toEqual(Object.keys(SAMPLE_INPUTS))
    for (const [name, task] of Object.entries(TASKS)) {
      expect({
        name: task.name,
        model: task.model,
        premium: task.premium ?? false,
        maxTokens: task.maxTokens,
        system: task.system,
        jsonSchema: task.jsonSchema,
        prompt: task.buildPrompt(SAMPLE_INPUTS[name]),
      }).toMatchSnapshot(name)
    }
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
