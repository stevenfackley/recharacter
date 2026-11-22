import { answersComplete, KURTA_QUESTIONS, type NexusAnswers } from '@/lib/nexus'
import type { CaseContext } from '@/lib/evidence'

/**
 * The case's step gates, each defined once. The pages decide what to show from
 * these, and the drafting actions and the packet route refuse on the same
 * predicates, so a button on a page and the gate behind it cannot disagree.
 * Each caller keeps its own refusal (a redirect, a status code); only the rule
 * lives here.
 *
 * Every gate takes only the state it reads, so no page loads data it does not
 * otherwise need.
 */

/** Step 1 is done: the veteran reviewed and submitted their service facts. */
export function hasConfirmedFacts<F extends { confirmed: boolean }>(
  facts: F | null,
): facts is F & { confirmed: true } {
  return facts?.confirmed === true
}

/** How many of the four answers hold more than whitespace. */
export function nexusAnsweredCount(answers: NexusAnswers | null): number {
  return KURTA_QUESTIONS.filter((q) => (answers?.[q.column] ?? '').trim().length > 0).length
}

declare const complete: unique symbol

/**
 * Answers `hasCompleteNexus` has checked. The brand exists only for the type
 * checker: it lets the guard narrow `NexusAnswers | null` to complete answers
 * without also claiming that incomplete answers are null.
 */
export type CompleteNexusAnswers = NexusAnswers & { readonly [complete]: true }

/** Step 4 is done: all four Kurta answers are present and not blank. */
export function hasCompleteNexus(answers: NexusAnswers | null): answers is CompleteNexusAnswers {
  return answers !== null && answersComplete(answers)
}

type FactsState = { facts: { confirmed: boolean } | null }

/** The personal statement is assembled from confirmed facts and all four answers. */
export function canDraftStatement(
  s: FactsState & { answers: NexusAnswers | null },
): boolean {
  return hasConfirmedFacts(s.facts) && hasCompleteNexus(s.answers)
}

/** The cover letter needs confirmed facts and the case details (the condition category). */
export function canDraftCoverLetter(s: FactsState & { ctx: CaseContext | null }): boolean {
  return hasConfirmedFacts(s.facts) && s.ctx !== null
}

/**
 * The packet route serves a download to an entitled owner with confirmed facts
 * and a personal statement. The cover letter and evidence are included when
 * present. The route can still refuse with a 503 when the routing service is
 * down, which no page can know ahead of time.
 */
export function packetReady(
  s: FactsState & { statement: object | null; entitled: boolean },
): boolean {
  return s.entitled && hasConfirmedFacts(s.facts) && s.statement !== null
}
