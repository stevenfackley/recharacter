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
})
