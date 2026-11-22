import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Whole-page pins for the evidence page: the case-details form (its condition
 * options, in order) and the checklist (its status options, in order, with the
 * saved status selected). Fixtures are obviously fake.
 */

const state: { ctx: Record<string, unknown> | null; statuses: Record<string, string> } = {
  ctx: null, statuses: {},
}

vi.mock('@/lib/session', () => ({
  requireSessionUser: async () => ({ id: 'owner-fixture', email: null }),
}))
vi.mock('@/lib/cases', () => ({ getOrCreateCase: async () => ({ id: 'case-fixture' }) }))
vi.mock('@/lib/context', () => ({ getCaseContext: async () => state.ctx }))
vi.mock('@/lib/evidence-items', () => ({ getEvidenceStatuses: async () => state.statuses }))
vi.mock('./actions', () => ({ saveContext: async () => {}, setItemStatus: async () => {} }))
vi.mock('./coaching', () => ({ CoachingSection: () => <div data-coaching="" /> }))

const markup = (node: ReactNode) =>
  renderToStaticMarkup(node)
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/action="javascript:[^"]*"/g, 'action="[server action]"')

const render = async (params: Record<string, string> = {}) => {
  const { default: EvidencePage } = await import('./page')
  return markup(await EvidencePage({ searchParams: Promise.resolve(params) }))
}

beforeEach(() => {
  state.ctx = null
  state.statuses = {}
})

describe('evidence page', () => {
  test('no case details yet: the condition form', async () => {
    expect(await render({ error: 'invalid_context' })).toMatchSnapshot()
  })

  test('case details saved: the checklist with saved statuses', async () => {
    state.ctx = { conditionCategory: 'tbi', mstInvolved: true, treatedInService: true, hasVaRating: false }
    state.statuses = { dd214: 'collected', buddy_statement: 'requested', nexus_letter: 'not_applicable' }
    expect(await render()).toMatchSnapshot()
  })
})
