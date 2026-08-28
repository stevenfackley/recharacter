import { describe, it, expect, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, freshOwner, pgCode, allowLedgerDelete } from './helpers'
import { closeDb } from '@/db'
import { cases, serviceFacts, aiUsage, entitlements } from '@/db/schema'

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

  it('ai_usage and entitlements refuse UPDATE/DELETE with 42501 outside account deletion', async () => {
    const owner = freshOwner()
    await db().insert(aiUsage).values({ ownerId: owner, task: 'ping', model: 'm', inputTokens: 1, outputTokens: 1 })
    await db().insert(entitlements).values({ ownerId: owner, stripeSessionId: `cs_${owner}` })
    await expect(db().update(aiUsage).set({ inputTokens: 0 }).where(eq(aiUsage.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    await expect(db().delete(aiUsage).where(eq(aiUsage.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    await expect(db().delete(entitlements).where(eq(entitlements.ownerId, owner))).rejects.toSatisfy((e) => pgCode(e) === '42501')
    expect((await db().select().from(aiUsage).where(eq(aiUsage.ownerId, owner))).length).toBe(1)
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
