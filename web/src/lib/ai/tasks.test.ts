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
})
