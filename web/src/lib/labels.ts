/**
 * Human display labels for the enum values that mirror the .NET RulesEngine
 * enums verbatim (see lib/facts.ts) and for evidence statuses. The branch and
 * characterization wordings are the words printed on the official DD forms —
 * ATTORNEY-REVIEW SURFACE, pinned by the packet golden-master tests. The UI and
 * the packet worksheet must render identical words, which is why this map is
 * shared rather than duplicated per screen.
 *
 * Each map `satisfies` a record over its value set (lib/domain.ts), so a value
 * added there without a label here fails the build instead of rendering raw.
 * The declared type stays string-keyed: callers look up stored strings.
 */

import type { Branch, Characterization, EvidenceStatus } from '@/lib/domain'

export const BRANCH_LABELS: Record<string, string> = {
  Army: 'Army',
  Navy: 'Navy',
  MarineCorps: 'Marine Corps',
  AirForce: 'Air Force',
  SpaceForce: 'Space Force',
  CoastGuard: 'Coast Guard',
} satisfies Record<Branch, string>

export const CHARACTERIZATION_LABELS: Record<string, string> = {
  Honorable: 'Honorable',
  GeneralUnderHonorable: 'General (Under Honorable Conditions)',
  OtherThanHonorable: 'Under Other Than Honorable Conditions',
  BadConductDischarge: 'Bad Conduct',
  DishonorableDischarge: 'Dishonorable',
  Uncharacterized: 'Uncharacterized (Entry-Level Separation)',
} satisfies Record<Characterization, string>

export const EVIDENCE_STATUS_LABELS: Record<string, string> = {
  needed: 'Needed',
  requested: 'Requested',
  collected: 'Collected',
  not_applicable: 'Not applicable',
} satisfies Record<EvidenceStatus, string>

export const branchLabel = (value: string): string => BRANCH_LABELS[value] ?? value

export const characterizationLabel = (value: string): string =>
  CHARACTERIZATION_LABELS[value] ?? value

export const evidenceStatusLabel = (value: string): string =>
  EVIDENCE_STATUS_LABELS[value] ?? value
