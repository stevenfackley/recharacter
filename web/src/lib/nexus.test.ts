import { describe, expect, test } from 'vitest'
import { KURTA_QUESTIONS, answersComplete, type NexusAnswers } from '@/lib/nexus'

describe('KURTA_QUESTIONS', () => {
  test('there are exactly four, keyed q1-q4, each with prompt and explainer', () => {
    expect(KURTA_QUESTIONS.map((q) => q.key)).toEqual(['q1', 'q2', 'q3', 'q4'])
    for (const q of KURTA_QUESTIONS) {
      expect(q.prompt.length).toBeGreaterThan(10)
      expect(q.explainer.length).toBeGreaterThan(10)
    }
  })
})

describe('answersComplete', () => {
  const full: NexusAnswers = {
    q1_condition: 'I developed an adjustment disorder…',
    q2_during_service: 'It began during my second year…',
    q3_mitigation: 'The conduct happened because…',
    q4_outweigh: 'My service before the incidents…',
  }

  test('true only when all four have substantive text', () => {
    expect(answersComplete(full)).toBe(true)
    expect(answersComplete({ ...full, q3_mitigation: '' })).toBe(false)
    expect(answersComplete({ ...full, q4_outweigh: '   ' })).toBe(false)
  })
})
