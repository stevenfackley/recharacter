import { describe, it, expect, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db, freshOwner, pgCode, allowLedgerDelete } from './helpers'
import { closeDb } from '@/db'
import { cases, serviceFacts, aiUsage, entitlements, evidenceItems, drafts } from '@/db/schema'

afterAll(closeDb)

describe('schema invariants', () => {
  it('one case per owner (23505)', async () => {
    const owner = freshOwner()
    await db().insert(cases).values({ ownerId: owner })
    await expect(db().insert(cases).values({ ownerId: owner })).rejects.toSatisfy((e) => pgCode(e) === '23505')
  })

  it('service_facts is unique per case and cascades on case delete', async () => {
    const owner = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    const row = { caseId: c.id, ownerId: owner, branch: 'Army', dischargeDate: '2015-01-01', characterization: 'OtherThanHonorable' }
    await db().insert(serviceFacts).values(row)
    await expect(db().insert(serviceFacts).values(row)).rejects.toSatisfy((e) => pgCode(e) === '23505')
    await db().delete(cases).where(eq(cases.id, c.id))
    expect(await db().select().from(serviceFacts).where(eq(serviceFacts.caseId, c.id))).toEqual([])
  })

  it('service_facts cannot carry an owner_id its case does not have (23503)', async () => {
    // The drift owner-scoped queries alone cannot prevent: a row whose case_id
    // is valid and whose owner_id is valid, but which pairs them with each
    // other. The composite (case_id, owner_id) FK into cases_id_owner_key is
    // what makes it unrepresentable rather than merely unlikely.
    const owner = freshOwner()
    const stranger = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    await expect(
      db().insert(serviceFacts).values({
        caseId: c.id, ownerId: stranger, branch: 'Army',
        dischargeDate: '2015-01-01', characterization: 'OtherThanHonorable',
      }),
    ).rejects.toSatisfy((e) => pgCode(e) === '23503')
  })

  it('drafts cannot carry an owner_id its case does not have (23503)', async () => {
    const owner = freshOwner()
    const stranger = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    await expect(
      db().insert(drafts).values({
        caseId: c.id, ownerId: stranger, kind: 'personal_statement', content: 'hijacked',
      }),
    ).rejects.toSatisfy((e) => pgCode(e) === '23503')
  })

  it('check constraints reject values outside the app enums (23514)', async () => {
    const owner = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    await expect(db().insert(serviceFacts).values({ caseId: c.id, ownerId: owner, branch: 'Militia', dischargeDate: '2015-01-01', characterization: 'OtherThanHonorable' }))
      .rejects.toSatisfy((e) => pgCode(e) === '23514')
  })

  it('updated_at moves on update', async () => {
    const owner = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    await new Promise((r) => setTimeout(r, 20))
    const [after] = await db().update(cases).set({ ownerId: owner }).where(eq(cases.id, c.id)).returning()
    expect(after.updatedAt.getTime()).toBeGreaterThan(c.updatedAt.getTime())
  })

  it('evidence_items is unique per (case, item_type) (23505)', async () => {
    const owner = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    const row = { caseId: c.id, ownerId: owner, itemType: 'dd214' }
    await db().insert(evidenceItems).values(row)
    await expect(db().insert(evidenceItems).values(row)).rejects.toSatisfy((e) => pgCode(e) === '23505')
  })

  it('drafts rejects a kind outside the app enum (23514)', async () => {
    const owner = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    await expect(db().insert(drafts).values({ caseId: c.id, ownerId: owner, kind: 'memoir', content: 'x' }))
      .rejects.toSatisfy((e) => pgCode(e) === '23514')
  })

  it('a stripe_session_id cannot be claimed by two owners (23505)', async () => {
    const session = `cs_${freshOwner()}`
    await db().insert(entitlements).values({ ownerId: freshOwner(), stripeSessionId: session })
    await expect(db().insert(entitlements).values({ ownerId: freshOwner(), stripeSessionId: session }))
      .rejects.toSatisfy((e) => pgCode(e) === '23505')
  })

  it('ai_usage and entitlements refuse UPDATE/DELETE with 42501 outside account deletion', async () => {
    const owner = freshOwner()
    await db().insert(aiUsage).values({ ownerId: owner, task: 'ping', model: 'm', inputTokens: 1, outputTokens: 1 })
    await db().insert(entitlements).values({ ownerId: owner, stripeSessionId: `cs_${owner}` })
    await expect(db().update(aiUsage).set({ inputTokens: 0 }).where(eq(aiUsage.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    await expect(db().update(entitlements).set({ kind: 'case_unlock' }).where(eq(entitlements.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    await expect(db().delete(aiUsage).where(eq(aiUsage.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    await expect(db().delete(entitlements).where(eq(entitlements.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    expect((await db().select().from(aiUsage).where(eq(aiUsage.ownerId, owner))).length).toBe(1)
  })

  it('TRUNCATE of either ledger is refused with 42501', async () => {
    // TRUNCATE skips row-level triggers, so this exercises the statement-level
    // guards rather than the ones the UPDATE/DELETE test covers.
    await expect(db().execute(sql.raw('truncate recharacter.ai_usage'))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    await expect(db().execute(sql.raw('truncate recharacter.entitlements'))).rejects.toSatisfy((e) => pgCode(e) === '42501')
  })

  it('the account-deletion transaction may delete from the ledgers', async () => {
    const owner = freshOwner()
    await db().insert(aiUsage).values({ ownerId: owner, task: 'ping', model: 'm', inputTokens: 1, outputTokens: 1 })
    await db().insert(entitlements).values({ ownerId: owner, stripeSessionId: `cs_${owner}` })
    await allowLedgerDelete(async (tx) => {
      await tx.delete(aiUsage).where(eq(aiUsage.ownerId, owner))
      await tx.delete(entitlements).where(eq(entitlements.ownerId, owner))
    })
    expect(await db().select().from(aiUsage).where(eq(aiUsage.ownerId, owner))).toEqual([])
    expect(await db().select().from(entitlements).where(eq(entitlements.ownerId, owner))).toEqual([])
  })
})
