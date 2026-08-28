import { describe, it, expect, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner } from './helpers'
import { closeDb } from '@/db'
import { serviceFacts } from '@/db/schema'
import { getOrCreateCase, CaseNotFoundError } from '@/lib/cases'
import {
  getServiceFacts,
  saveServiceFacts,
  confirmServiceFacts,
  type ServiceFacts,
} from '@/lib/facts'

afterAll(closeDb)

const facts: ServiceFacts = {
  branch: 'MarineCorps',
  dischargeDate: '2024-06-01',
  characterization: 'OtherThanHonorable',
  wasGeneralCourtMartial: false,
}

/** Alice with a case, plus a second owner who has nothing to do with it. */
async function twoOwners() {
  const alice = freshOwner()
  const bob = freshOwner()
  const aliceCase = await getOrCreateCase(alice)
  return { alice, bob, caseId: aliceCase.id }
}

describe('service facts round-trip', () => {
  it('saves and reads back every field, unconfirmed', async () => {
    const { alice, caseId } = await twoOwners()
    await saveServiceFacts(alice, caseId, facts, 'extracted')
    const row = await getServiceFacts(alice, caseId)
    expect(row).toMatchObject({ ...facts, case_id: caseId, source: 'extracted', confirmed: false })
    expect(row?.id).toEqual(expect.any(String))
  })

  it('saving twice updates in place rather than adding a row', async () => {
    const { alice, caseId } = await twoOwners()
    await saveServiceFacts(alice, caseId, facts, 'manual')
    await saveServiceFacts(alice, caseId, { ...facts, branch: 'Navy' }, 'manual')
    const rows = await db().select().from(serviceFacts).where(eq(serviceFacts.caseId, caseId))
    expect(rows).toHaveLength(1)
    expect((await getServiceFacts(alice, caseId))?.branch).toBe('Navy')
  })
})

describe('owner scoping', () => {
  it("another owner reads null for Alice's facts", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await saveServiceFacts(alice, caseId, facts, 'manual')
    expect(await getServiceFacts(bob, caseId)).toBeNull()
  })

  it("another owner's save on Alice's case is refused and changes nothing", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await saveServiceFacts(alice, caseId, facts, 'manual')
    await expect(
      saveServiceFacts(bob, caseId, { ...facts, branch: 'Army' }, 'manual'),
    ).rejects.toBeInstanceOf(CaseNotFoundError)
    expect(await getServiceFacts(alice, caseId)).toMatchObject({ branch: 'MarineCorps' })
  })

  it("another owner cannot confirm Alice's facts", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await saveServiceFacts(alice, caseId, facts, 'manual')
    await expect(confirmServiceFacts(bob, caseId, facts)).rejects.toBeInstanceOf(CaseNotFoundError)
    expect(await getServiceFacts(alice, caseId)).toMatchObject({ confirmed: false })
  })
})

describe('the confirmation gate', () => {
  it('confirming untouched extracted values keeps the extracted provenance', async () => {
    const { alice, caseId } = await twoOwners()
    await saveServiceFacts(alice, caseId, facts, 'extracted')
    await confirmServiceFacts(alice, caseId, facts)
    expect(await getServiceFacts(alice, caseId)).toMatchObject({ source: 'extracted', confirmed: true })
  })

  it('confirming EDITED extracted values makes them manual', async () => {
    const { alice, caseId } = await twoOwners()
    await saveServiceFacts(alice, caseId, facts, 'extracted')
    await confirmServiceFacts(alice, caseId, { ...facts, branch: 'Army' })
    expect(await getServiceFacts(alice, caseId)).toMatchObject({
      branch: 'Army',
      source: 'manual',
      confirmed: true,
    })
  })

  it('an ordinary save can never set confirmed — only confirmServiceFacts can', async () => {
    const { alice, caseId } = await twoOwners()
    await confirmServiceFacts(alice, caseId, facts)
    expect(await getServiceFacts(alice, caseId)).toMatchObject({ confirmed: true })
    await saveServiceFacts(alice, caseId, { ...facts, branch: 'Navy' }, 'extracted')
    expect(await getServiceFacts(alice, caseId)).toMatchObject({ branch: 'Navy', confirmed: false })
  })
})
