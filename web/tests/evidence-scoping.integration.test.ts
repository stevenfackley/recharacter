import { describe, it, expect, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner } from './helpers'
import { closeDb } from '@/db'
import { evidenceItems } from '@/db/schema'
import { getOrCreateCase, CaseNotFoundError } from '@/lib/cases'
import { getCaseContext, saveCaseContext } from '@/lib/context'
import { getEvidenceStatuses, setEvidenceStatus } from '@/lib/evidence-items'
import type { CaseContext } from '@/lib/evidence'

afterAll(closeDb)

const ctx: CaseContext = {
  conditionCategory: 'ptsd',
  mstInvolved: true,
  treatedInService: false,
  hasVaRating: true,
}

async function twoOwners() {
  const alice = freshOwner()
  const bob = freshOwner()
  const aliceCase = await getOrCreateCase(alice)
  return { alice, bob, caseId: aliceCase.id }
}

describe('case context', () => {
  it('round-trips every field', async () => {
    const { alice, caseId } = await twoOwners()
    await saveCaseContext(alice, caseId, ctx)
    expect(await getCaseContext(alice, caseId)).toEqual(ctx)
  })

  it('saving twice updates in place', async () => {
    const { alice, caseId } = await twoOwners()
    await saveCaseContext(alice, caseId, ctx)
    await saveCaseContext(alice, caseId, { ...ctx, conditionCategory: 'tbi', mstInvolved: false })
    expect(await getCaseContext(alice, caseId)).toEqual({
      ...ctx,
      conditionCategory: 'tbi',
      mstInvolved: false,
    })
  })

  it("another owner reads null for Alice's context", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await saveCaseContext(alice, caseId, ctx)
    expect(await getCaseContext(bob, caseId)).toBeNull()
  })

  it("another owner's save on Alice's case is refused and changes nothing", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await saveCaseContext(alice, caseId, ctx)
    await expect(
      saveCaseContext(bob, caseId, { ...ctx, conditionCategory: 'unsure' }),
    ).rejects.toBeInstanceOf(CaseNotFoundError)
    expect(await getCaseContext(alice, caseId)).toEqual(ctx)
  })
})

describe('evidence item statuses', () => {
  it('reads back what was set, keyed by item type', async () => {
    const { alice, caseId } = await twoOwners()
    await setEvidenceStatus(alice, caseId, 'nexus_letter', 'requested')
    expect(await getEvidenceStatuses(alice, caseId)).toEqual({ nexus_letter: 'requested' })
  })

  it('setting the same item twice updates the one row', async () => {
    const { alice, caseId } = await twoOwners()
    await setEvidenceStatus(alice, caseId, 'nexus_letter', 'requested')
    await setEvidenceStatus(alice, caseId, 'nexus_letter', 'collected')
    const rows = await db().select().from(evidenceItems).where(eq(evidenceItems.caseId, caseId))
    expect(rows).toHaveLength(1)
    expect(await getEvidenceStatuses(alice, caseId)).toEqual({ nexus_letter: 'collected' })
  })

  it('tracks several item types independently', async () => {
    const { alice, caseId } = await twoOwners()
    await setEvidenceStatus(alice, caseId, 'dd214', 'collected')
    await setEvidenceStatus(alice, caseId, 'buddy_statement', 'not_applicable')
    expect(await getEvidenceStatuses(alice, caseId)).toEqual({
      dd214: 'collected',
      buddy_statement: 'not_applicable',
    })
  })

  it("another owner sees an empty status map for Alice's case", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await setEvidenceStatus(alice, caseId, 'dd214', 'collected')
    expect(await getEvidenceStatuses(bob, caseId)).toEqual({})
  })

  it("another owner cannot set a status on Alice's case", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await setEvidenceStatus(alice, caseId, 'dd214', 'collected')
    await expect(
      setEvidenceStatus(bob, caseId, 'dd214', 'needed'),
    ).rejects.toBeInstanceOf(CaseNotFoundError)
    expect(await getEvidenceStatuses(alice, caseId)).toEqual({ dd214: 'collected' })
  })
})
