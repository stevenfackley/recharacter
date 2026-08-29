import { describe, it, expect, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db, freshOwner, pgCode, allowLedgerDelete } from './helpers'
import { closeDb } from '@/db'
import {
  cases, serviceFacts, caseContext, evidenceItems, nexusAnswers, drafts, aiUsage, entitlements,
} from '@/db/schema'

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

  it('case_context cannot carry an owner_id its case does not have (23503)', async () => {
    const owner = freshOwner()
    const stranger = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    await expect(
      db().insert(caseContext).values({ caseId: c.id, ownerId: stranger, conditionCategory: 'ptsd' }),
    ).rejects.toSatisfy((e) => pgCode(e) === '23503')
  })

  it('evidence_items cannot carry an owner_id its case does not have (23503)', async () => {
    const owner = freshOwner()
    const stranger = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    await expect(
      db().insert(evidenceItems).values({ caseId: c.id, ownerId: stranger, itemType: 'dd214' }),
    ).rejects.toSatisfy((e) => pgCode(e) === '23503')
  })

  it('nexus_answers cannot carry an owner_id its case does not have (23503)', async () => {
    const owner = freshOwner()
    const stranger = freshOwner()
    const [c] = await db().insert(cases).values({ ownerId: owner }).returning()
    await expect(
      db().insert(nexusAnswers).values({ caseId: c.id, ownerId: stranger, q1Condition: 'hijacked' }),
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

  it('the ledger guard leaves INSERT alone: both ledgers accept new rows', async () => {
    // The guard is BEFORE UPDATE OR DELETE plus BEFORE TRUNCATE. An append-only
    // table that also refused appends would be a very quiet outage.
    const owner = freshOwner()
    const [usage] = await db().insert(aiUsage)
      .values({ ownerId: owner, task: 'ping', model: 'm', inputTokens: 1, outputTokens: 1 })
      .returning()
    const [entitlement] = await db().insert(entitlements)
      .values({ ownerId: owner, stripeSessionId: `cs_${owner}` })
      .returning()
    expect(usage).toMatchObject({ ownerId: owner, task: 'ping' })
    expect(entitlement).toMatchObject({ ownerId: owner, kind: 'case_unlock' })
  })

  it('allow_ledger_delete is transaction-local: a concurrent transaction is still refused, and so is the next statement after commit', async () => {
    const alice = freshOwner()
    const bob = freshOwner()
    await db().insert(aiUsage).values([
      { ownerId: alice, task: 'ping', model: 'm', inputTokens: 1, outputTokens: 1 },
      { ownerId: bob, task: 'ping', model: 'm', inputTokens: 1, outputTokens: 1 },
    ])

    // Two connections from the pool, handshaking so the second DELETE is
    // attempted while the first transaction is still open with the GUC on.
    // Different owners on purpose: the BEFORE DELETE trigger locks the target
    // row first, so aiming both at the same row would just block the second
    // transaction behind the first instead of testing the setting's scope.
    let firstHasDeleted!: () => void
    const firstDeleted = new Promise<void>((resolve) => { firstHasDeleted = resolve })
    let secondIsDone!: () => void
    const secondDone = new Promise<void>((resolve) => { secondIsDone = resolve })

    const first = db().transaction(async (tx) => {
      try {
        await tx.execute(sql.raw(`SET LOCAL recharacter.allow_ledger_delete = 'on'`))
        const gone = await tx.delete(aiUsage).where(eq(aiUsage.ownerId, alice)).returning({ id: aiUsage.id })
        expect(gone).toHaveLength(1)
      } finally {
        firstHasDeleted()
      }
      // Hold the transaction open — GUC still 'on' on THIS connection — until
      // the other connection has had its answer.
      await secondDone
    })

    const second = db().transaction(async (tx) => {
      await firstDeleted
      try {
        await tx.delete(aiUsage).where(eq(aiUsage.ownerId, bob))
      } finally {
        secondIsDone()
      }
    })

    const [, outcome] = await Promise.all([
      first,
      second.then(() => 'resolved' as const, (err: unknown) => err),
    ])
    expect(outcome).not.toBe('resolved')
    expect(pgCode(outcome)).toBe('42501')

    // Committed: Alice's row is gone, the setting went with the transaction.
    expect(await db().select().from(aiUsage).where(eq(aiUsage.ownerId, alice))).toEqual([])
    const [{ setting }] = await db().execute<{ setting: string | null }>(
      sql`select current_setting('recharacter.allow_ledger_delete', true) as setting`,
    )
    expect(setting).not.toBe('on')
    await expect(db().delete(aiUsage).where(eq(aiUsage.ownerId, bob)))
      .rejects.toSatisfy((e) => pgCode(e) === '42501')
    expect(await db().select().from(aiUsage).where(eq(aiUsage.ownerId, bob))).toHaveLength(1)
  })
})
