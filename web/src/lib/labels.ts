/**
 * Human display labels for the enum values that mirror the .NET RulesEngine
 * enums verbatim (see lib/facts.ts) and for evidence statuses. The branch and
 * characterization wordings are the words printed on the official DD forms —
 * ATTORNEY-REVIEW SURFACE, pinned by the packet golden-master tests. The UI and
 * the packet worksheet must render identical words, which is why this map is
 * shared rather than duplicated per screen.
 */

export const BRANCH_LABELS: Record<string, string> = {
  Army: 'Army',
  Navy: 'Navy',
  MarineCorps: 'Marine Corps',
  AirForce: 'Air Force',
  SpaceForce: 'Space Force',
  CoastGuard: 'Coast Guard',
}

export const CHARACTERIZATION_LABELS: Record<string, string> = {
  Honorable: 'Honorable',
  GeneralUnderHonorable: 'General (Under Honorable Conditions)',
  OtherThanHonorable: 'Under Other Than Honorable Conditions',
  BadConductDischarge: 'Bad Conduct',
  DishonorableDischarge: 'Dishonorable',
  Uncharacterized: 'Uncharacterized (Entry-Level Separation)',
}

export const EVIDENCE_STATUS_LABELS: Record<string, string> = {
  needed: 'Needed',
  requested: 'Requested',
  collected: 'Collected',
  not_applicable: 'Not applicable',
}

export const branchLabel = (value: string): string => BRANCH_LABELS[value] ?? value

export const characterizationLabel = (value: string): string =>
  CHARACTERIZATION_LABELS[value] ?? value

export const evidenceStatusLabel = (value: string): string =>
  EVIDENCE_STATUS_LABELS[value] ?? value
