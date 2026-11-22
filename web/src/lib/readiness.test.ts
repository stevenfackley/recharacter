import { describe, expect, test } from 'vitest'
import {
  canDraftCoverLetter, canDraftStatement, hasCompleteNexus, hasConfirmedFacts,
  nexusAnsweredCount, packetReady,
} from './readiness'

const CONFIRMED = { confirmed: true }
const UNCONFIRMED = { confirmed: false }
const COMPLETE = {
  q1_condition: 'one', q2_during_service: 'two', q3_mitigation: 'three', q4_outweigh: 'four',
}
const PARTIAL = { ...COMPLETE, q2_during_service: ' \n\t', q4_outweigh: '' }
const BLANK = { q1_condition: '', q2_during_service: '', q3_mitigation: '', q4_outweigh: '' }
const CTX = { conditionCategory: 'ptsd', mstInvolved: false, treatedInService: false, hasVaRating: false } as const
const STATEMENT = { kind: 'personal_statement', content: 'text', edited: false, generated_at: '2001-01-01' }

describe('hasConfirmedFacts', () => {
  test.each([
    ['no facts row', null, false],
    ['saved, not confirmed', UNCONFIRMED, false],
    ['confirmed', CONFIRMED, true],
  ])('%s', (_name, facts, expected) => {
    expect(hasConfirmedFacts(facts)).toBe(expected)
  })
})

describe('nexus answers', () => {
  test.each([
    ['no answers row', null, 0, false],
    ['all blank', BLANK, 0, false],
    ['two filled, one whitespace-only, one empty', PARTIAL, 2, false],
    ['all four', COMPLETE, 4, true],
  ])('%s', (_name, answers, count, complete) => {
    expect(nexusAnsweredCount(answers)).toBe(count)
    expect(hasCompleteNexus(answers)).toBe(complete)
  })
})

describe('drafting gates', () => {
  test.each([
    [null, null, false],
    [UNCONFIRMED, COMPLETE, false],
    [CONFIRMED, null, false],
    [CONFIRMED, PARTIAL, false],
    [CONFIRMED, COMPLETE, true],
  ])('statement: facts %j, answers %j -> %s', (facts, answers, expected) => {
    expect(canDraftStatement({ facts, answers })).toBe(expected)
  })

  test.each([
    [null, null, false],
    [null, CTX, false],
    [UNCONFIRMED, CTX, false],
    [CONFIRMED, null, false],
    [CONFIRMED, CTX, true],
  ])('cover letter: facts %j, context %j -> %s', (facts, ctx, expected) => {
    expect(canDraftCoverLetter({ facts, ctx })).toBe(expected)
  })

  test('the cover letter does not wait on the nexus answers', () => {
    expect(canDraftCoverLetter({ facts: CONFIRMED, ctx: CTX })).toBe(true)
    expect(canDraftStatement({ facts: CONFIRMED, answers: PARTIAL })).toBe(false)
  })
})

describe('packetReady', () => {
  test.each([
    [CONFIRMED, STATEMENT, true, true],
    [CONFIRMED, STATEMENT, false, false],
    [UNCONFIRMED, STATEMENT, true, false],
    [null, STATEMENT, true, false],
    [CONFIRMED, null, true, false],
    [null, null, false, false],
  ])('facts %j, statement %j, entitled %s -> %s', (facts, statement, entitled, expected) => {
    expect(packetReady({ facts, statement, entitled })).toBe(expected)
  })
})
