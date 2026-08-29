import { describe, it, expect, afterAll } from 'vitest'
import { freshOwner } from './helpers'
import { closeDb } from '@/db'
import { getOrCreateCase, CaseNotFoundError } from '@/lib/cases'
import { getNexusAnswers, saveNexusAnswer } from '@/lib/nexus'
import { getDraft, saveGeneratedDraft, saveEditedDraft } from '@/lib/drafts'

afterAll(closeDb)

async function twoOwners() {
  const alice = freshOwner()
  const bob = freshOwner()
  const aliceCase = await getOrCreateCase(alice)
  return { alice, bob, caseId: aliceCase.id }
}

describe('nexus answers', () => {
  it('saves one answer per call without blanking the others', async () => {
    const { alice, caseId } = await twoOwners()
    await saveNexusAnswer(alice, caseId, 'q1', 'adjustment disorder')
    await saveNexusAnswer(alice, caseId, 'q2', 'it began in my second year')
    expect(await getNexusAnswers(alice, caseId)).toEqual({
      q1_condition: 'adjustment disorder',
      q2_during_service: 'it began in my second year',
      q3_mitigation: '',
      q4_outweigh: '',
    })
  })

  it('rewriting one answer leaves the rest alone', async () => {
    const { alice, caseId } = await twoOwners()
    await saveNexusAnswer(alice, caseId, 'q3', 'the conduct followed from it')
    await saveNexusAnswer(alice, caseId, 'q3', 'rewritten')
    await saveNexusAnswer(alice, caseId, 'q4', 'my whole record')
    expect(await getNexusAnswers(alice, caseId)).toMatchObject({
      q3_mitigation: 'rewritten',
      q4_outweigh: 'my whole record',
    })
  })

  it("another owner reads null for Alice's answers", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await saveNexusAnswer(alice, caseId, 'q1', 'adjustment disorder')
    expect(await getNexusAnswers(bob, caseId)).toBeNull()
  })

  it("another owner's save on Alice's case is refused and changes nothing", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await saveNexusAnswer(alice, caseId, 'q1', 'adjustment disorder')
    await expect(
      saveNexusAnswer(bob, caseId, 'q1', 'hijacked'),
    ).rejects.toBeInstanceOf(CaseNotFoundError)
    expect(await getNexusAnswers(alice, caseId)).toMatchObject({ q1_condition: 'adjustment disorder' })
  })
})

describe('drafts', () => {
  it('a generated draft reads back unedited', async () => {
    const { alice, caseId } = await twoOwners()
    await saveGeneratedDraft(alice, caseId, 'personal_statement', 'machine text')
    expect(await getDraft(alice, caseId, 'personal_statement')).toMatchObject({
      kind: 'personal_statement',
      content: 'machine text',
      edited: false,
    })
  })

  it("the veteran's edit marks the draft edited", async () => {
    const { alice, caseId } = await twoOwners()
    await saveGeneratedDraft(alice, caseId, 'personal_statement', 'machine text')
    await saveEditedDraft(alice, caseId, 'personal_statement', 'my own words')
    expect(await getDraft(alice, caseId, 'personal_statement')).toMatchObject({
      content: 'my own words',
      edited: true,
    })
  })

  it("the veteran's edit preserves generated_at", async () => {
    // generated_at is when the MACHINE wrote the text. An edit is the veteran's
    // own revision of that text, not a new generation, so the stamp must survive.
    const { alice, caseId } = await twoOwners()
    await saveGeneratedDraft(alice, caseId, 'personal_statement', 'machine text')
    const before = await getDraft(alice, caseId, 'personal_statement')
    await new Promise((r) => setTimeout(r, 20))
    await saveEditedDraft(alice, caseId, 'personal_statement', 'my own words')
    const after = await getDraft(alice, caseId, 'personal_statement')
    expect(before?.generated_at).toEqual(expect.any(String))
    expect(after?.generated_at).toBe(before?.generated_at)
    expect(after).toMatchObject({ content: 'my own words', edited: true })
  })

  it('reads null for a kind that was never generated, even when the other kind exists', async () => {
    const { alice, caseId } = await twoOwners()
    await saveGeneratedDraft(alice, caseId, 'personal_statement', 'statement')
    expect(await getDraft(alice, caseId, 'cover_letter')).toBeNull()
  })

  it('regenerating resets edited to false', async () => {
    const { alice, caseId } = await twoOwners()
    await saveGeneratedDraft(alice, caseId, 'cover_letter', 'v1')
    await saveEditedDraft(alice, caseId, 'cover_letter', 'v1 edited')
    await saveGeneratedDraft(alice, caseId, 'cover_letter', 'v2')
    expect(await getDraft(alice, caseId, 'cover_letter')).toMatchObject({
      content: 'v2',
      edited: false,
    })
  })

  it('draft kinds are stored independently', async () => {
    const { alice, caseId } = await twoOwners()
    await saveGeneratedDraft(alice, caseId, 'personal_statement', 'statement')
    await saveGeneratedDraft(alice, caseId, 'cover_letter', 'letter')
    expect((await getDraft(alice, caseId, 'personal_statement'))?.content).toBe('statement')
    expect((await getDraft(alice, caseId, 'cover_letter'))?.content).toBe('letter')
  })

  it("another owner reads null for Alice's draft", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await saveGeneratedDraft(alice, caseId, 'personal_statement', 'machine text')
    expect(await getDraft(bob, caseId, 'personal_statement')).toBeNull()
  })

  it("another owner cannot overwrite Alice's draft", async () => {
    const { alice, bob, caseId } = await twoOwners()
    await saveGeneratedDraft(alice, caseId, 'personal_statement', 'machine text')
    await expect(
      saveEditedDraft(bob, caseId, 'personal_statement', 'hijacked'),
    ).rejects.toBeInstanceOf(CaseNotFoundError)
    await expect(
      saveGeneratedDraft(bob, caseId, 'personal_statement', 'hijacked'),
    ).rejects.toBeInstanceOf(CaseNotFoundError)
    expect(await getDraft(alice, caseId, 'personal_statement')).toMatchObject({
      content: 'machine text',
    })
  })
})
