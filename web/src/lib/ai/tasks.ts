import { z } from 'zod'

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
  buildPrompt: (input: unknown) => string
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

export const TASKS: Record<string, AiTask> = { ping }

export function getTask(name: string): AiTask | undefined {
  return TASKS[name]
}
