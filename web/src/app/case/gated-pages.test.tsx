import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Whole-page pins for the four screens that show a case step as open or
 * closed: the case hub, the nexus questions, the drafts page and the packet
 * page. Each state renders the full markup and compares it to the recorded
 * snapshot, so a gate that moves (a Generate button shown when the action
 * would refuse, a download link shown before the route would serve it) fails
 * here rather than on a veteran's screen.
 *
 * Fixtures are obviously fake; nothing here resembles a real record.
 */

type State = {
  facts: Record<string, unknown> | null
  answers: Record<string, string> | null
  ctx: Record<string, unknown> | null
  drafts: Record<string, Record<string, unknown> | null>
  statuses: Record<string, string>
  entitled: boolean
  routing: 'ok' | 'down'
}

const state: State = {} as State

vi.mock('@/lib/session', () => ({
  requireSessionUser: async () => ({ id: 'owner-fixture', email: null }),
}))
vi.mock('@/lib/cases', () => ({ getOrCreateCase: async () => ({ id: 'case-fixture' }) }))
vi.mock('@/lib/facts', () => ({ getServiceFacts: async () => state.facts }))
vi.mock('@/lib/context', () => ({ getCaseContext: async () => state.ctx }))
vi.mock('@/lib/nexus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nexus')>()
  return { ...actual, getNexusAnswers: async () => state.answers }
})
vi.mock('@/lib/drafts', () => ({
  getDraft: async (_owner: string, _case: string, kind: string) => state.drafts[kind] ?? null,
}))
vi.mock('@/lib/evidence-items', () => ({ getEvidenceStatuses: async () => state.statuses }))
vi.mock('@/lib/billing', () => ({ isEntitled: async () => state.entitled }))
vi.mock('@/lib/routing', () => ({
  routeDischarge: async () => {
    if (state.routing === 'down') throw new Error('routing down')
    return {
      recommendedBoard: 'Drb', recommendedForm: 'DD293', boardName: 'Fixture Review Board',
      availableBoards: ['Drb', 'Bcmr'], drbDeadline: '2099-01-01', drbWindowOpen: true,
      flags: ['BcmrThreeYearStatuteWaiverLikely'],
    }
  },
}))
vi.mock('@/app/case/draft/actions', () => ({
  saveDraft: async () => {}, generateStatement: async () => {}, generateCoverLetter: async () => {},
}))
vi.mock('@/app/case/nexus/question', () => ({
  NexusQuestion: ({ qKey, initialText }: { qKey: string; initialText: string }) => (
    <div data-question={qKey}>{initialText}</div>
  ),
}))

const FACTS = {
  id: 'facts-fixture', case_id: 'case-fixture', branch: 'Army', dischargeDate: '2001-02-03',
  characterization: 'GeneralUnderHonorable', wasGeneralCourtMartial: false,
  source: 'manual', confirmed: true,
}
const ANSWERS = {
  q1_condition: 'Fixture answer one', q2_during_service: 'Fixture answer two',
  q3_mitigation: 'Fixture answer three', q4_outweigh: 'Fixture answer four',
}
const PARTIAL_ANSWERS = { ...ANSWERS, q3_mitigation: '   ', q4_outweigh: '' }
const CTX = { conditionCategory: 'ptsd', mstInvolved: false, treatedInService: false, hasVaRating: false }
const draft = (kind: string, edited: boolean) => ({
  kind, content: `Fixture ${kind} text`, edited, generated_at: '2001-02-03T04:05:06.000Z',
})

beforeEach(() => {
  Object.assign(state, {
    facts: null, answers: null, ctx: null, drafts: {}, statuses: {}, entitled: false, routing: 'ok',
  } satisfies State)
  // The drafts page prints generated_at in the server's locale and zone.
  vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('FIXED-TIMESTAMP')
})

const unconfirmed = () => ({ ...FACTS, confirmed: false })

/**
 * React's markup for a function-valued form action (a javascript: URL plus a
 * replay script) belongs to React, not to these pages. Normalizing it keeps a
 * React bump from failing every snapshot here.
 */
const markup = (node: ReactNode) =>
  renderToStaticMarkup(node)
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/action="javascript:[^"]*"/g, 'action="[server action]"')

describe('case hub', () => {
  const render = async () => {
    const { default: CasePage } = await import('./page')
    return markup(await CasePage())
  }

  test('no facts yet', async () => {
    expect(await render()).toMatchSnapshot()
  })

  test('facts saved but not confirmed, nexus complete', async () => {
    Object.assign(state, { facts: unconfirmed(), answers: ANSWERS })
    expect(await render()).toMatchSnapshot()
  })

  test('confirmed facts, partial nexus', async () => {
    Object.assign(state, { facts: FACTS, answers: PARTIAL_ANSWERS })
    expect(await render()).toMatchSnapshot()
  })

  test('confirmed facts, nexus complete', async () => {
    Object.assign(state, { facts: FACTS, answers: ANSWERS })
    expect(await render()).toMatchSnapshot()
  })

  test('confirmed facts, routing service down', async () => {
    Object.assign(state, { facts: FACTS, routing: 'down' })
    expect(await render()).toMatchSnapshot()
  })
})

describe('nexus page', () => {
  const render = async () => {
    const { default: NexusPage } = await import('./nexus/page')
    return markup(await NexusPage())
  }

  test('no answers row, facts not confirmed', async () => {
    expect(await render()).toMatchSnapshot()
  })

  test('partial answers, confirmed facts', async () => {
    Object.assign(state, { facts: FACTS, answers: PARTIAL_ANSWERS })
    expect(await render()).toMatchSnapshot()
  })

  test('complete answers, confirmed facts', async () => {
    Object.assign(state, { facts: FACTS, answers: ANSWERS })
    expect(await render()).toMatchSnapshot()
  })

  test('complete answers, unconfirmed facts', async () => {
    Object.assign(state, { facts: unconfirmed(), answers: ANSWERS })
    expect(await render()).toMatchSnapshot()
  })
})

describe('drafts page', () => {
  const render = async (params: Record<string, string> = {}) => {
    const { default: DraftPage } = await import('./draft/page')
    return markup(await DraftPage({ searchParams: Promise.resolve(params) }))
  }

  test('nothing done yet', async () => {
    expect(await render()).toMatchSnapshot()
  })

  test('facts unconfirmed, nexus complete, context saved', async () => {
    Object.assign(state, { facts: unconfirmed(), answers: ANSWERS, ctx: CTX })
    expect(await render()).toMatchSnapshot()
  })

  test('facts confirmed, nexus partial, no context', async () => {
    Object.assign(state, { facts: FACTS, answers: PARTIAL_ANSWERS })
    expect(await render()).toMatchSnapshot()
  })

  test('facts confirmed, nexus complete, context saved, no drafts', async () => {
    Object.assign(state, { facts: FACTS, answers: ANSWERS, ctx: CTX })
    expect(await render()).toMatchSnapshot()
  })

  test('both drafts exist, one edited, generation open, with an error and a confirm prompt', async () => {
    Object.assign(state, {
      facts: FACTS, answers: ANSWERS, ctx: CTX,
      drafts: { personal_statement: draft('personal_statement', true), cover_letter: draft('cover_letter', false) },
    })
    expect(await render({ error: 'rate_limited', confirm: 'statement' })).toMatchSnapshot()
  })

  test('drafts exist but generation is closed (facts since unconfirmed), unknown error code', async () => {
    Object.assign(state, {
      facts: unconfirmed(), answers: ANSWERS, ctx: CTX,
      drafts: { personal_statement: draft('personal_statement', false), cover_letter: draft('cover_letter', true) },
    })
    expect(await render({ error: 'not_a_code', confirm: 'cover_letter' })).toMatchSnapshot()
  })
})

describe('packet page', () => {
  const render = async () => {
    const { default: PacketPage } = await import('./packet/page')
    return markup(await PacketPage())
  }

  test('nothing ready, not entitled', async () => {
    expect(await render()).toMatchSnapshot()
  })

  test('facts and statement ready, not entitled', async () => {
    Object.assign(state, {
      facts: FACTS, drafts: { personal_statement: draft('personal_statement', false) },
      statuses: { dd214: 'collected' },
    })
    expect(await render()).toMatchSnapshot()
  })

  test('entitled, statement drafted, facts unconfirmed', async () => {
    Object.assign(state, {
      facts: unconfirmed(), entitled: true,
      drafts: { personal_statement: draft('personal_statement', false) },
    })
    expect(await render()).toMatchSnapshot()
  })

  test('entitled, facts confirmed, no statement', async () => {
    Object.assign(state, { facts: FACTS, entitled: true, drafts: { cover_letter: draft('cover_letter', false) } })
    expect(await render()).toMatchSnapshot()
  })

  test('ready: entitled, facts confirmed, statement and cover letter, two items collected', async () => {
    Object.assign(state, {
      facts: FACTS, entitled: true,
      drafts: { personal_statement: draft('personal_statement', false), cover_letter: draft('cover_letter', true) },
      statuses: { dd214: 'collected', buddy_statement: 'collected', nexus_letter: 'requested' },
    })
    expect(await render()).toMatchSnapshot()
  })
})
