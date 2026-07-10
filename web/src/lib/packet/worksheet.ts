import type { PacketInput } from './sections'
import { BRANCH_LABELS, CHARACTERIZATION_LABELS } from '@/lib/labels'

/**
 * Item-number row tables for the two official forms. Every string here is
 * ATTORNEY-REVIEW SURFACE. Item numbers were verified against the text of the
 * CURRENT form revisions — DD Form 293 (DEC 2019) and DD Form 149 (JAN 2023) —
 * not guessed; if DoD revises either form, this table must be re-verified
 * (golden-master tests pin today's numbering). We never collected name/SSN/
 * address/phone/email or a REQUESTED characterization in intake, so those rows
 * render bracketed placeholders for the veteran to fill in — never invented
 * data. Long-form answers are attached, not transcribed: "SEE ATTACHED
 * STATEMENT" is standard practice for these forms.
 */

type WorksheetRow = { item: string; value: string }

const REQUESTED_CHARACTERIZATION_GUIDANCE =
  '[The characterization you are requesting — most mental-health petitions request Honorable ' +
  'or General (Under Honorable Conditions)]'

const branchLabel = (input: PacketInput) => BRANCH_LABELS[input.facts.branch] ?? input.facts.branch
const characterizationLabel = (input: PacketInput) =>
  CHARACTERIZATION_LABELS[input.facts.characterization] ?? input.facts.characterization

/** DD Form 293, DEC 2019 revision. */
function dd293Rows(input: PacketInput): WorksheetRow[] {
  return [
    { item: 'Item 1 — Branch of service at the time', value: branchLabel(input) },
    { item: 'Item 3 — Name while serving', value: '[Your full name as it appeared in service]' },
    { item: 'Item 4 — Current name', value: '[Your current full legal name]' },
    { item: 'Item 5a — Social Security Number', value: '[Your Social Security Number]' },
    {
      item: 'Item 6 — Mailing address (includes phone and email)',
      value: '[Your mailing address, daytime phone number, and email address]',
    },
    { item: 'Item 8 — Date of discharge', value: input.facts.dischargeDate },
    { item: 'Item 11 — Characterization of service received', value: characterizationLabel(input) },
    { item: 'Item 16 — Unit and location at discharge', value: '[Your unit and its location at discharge]' },
    {
      item: 'Items 17a/17b — Prior applications',
      value: '[List any prior applications to this board, or check "No"]',
    },
    { item: 'Item 18 — Action requested (change of characterization)', value: REQUESTED_CHARACTERIZATION_GUIDANCE },
    { item: 'Item 22 — Why the change is requested (issues)', value: 'SEE ATTACHED STATEMENT' },
    { item: 'Items 24-26 — Counsel or representative', value: '[None, unless you have one]' },
    { item: 'Item 29a — Applicant signature', value: '[Sign by hand — unsigned applications are returned]' },
    { item: 'Item 29b — Date signed', value: '[The date you sign]' },
  ]
}

/** DD Form 149, JAN 2023 revision. */
function dd149Rows(input: PacketInput): WorksheetRow[] {
  return [
    { item: 'Item 1 — Branch of service at the time', value: branchLabel(input) },
    { item: 'Item 3 — Name while serving', value: '[Your full name as it appeared in service]' },
    { item: 'Item 4 — Current name', value: '[Your current full legal name]' },
    { item: 'Item 5a — Social Security Number', value: '[Your Social Security Number]' },
    { item: 'Item 7 — Date of separation', value: input.facts.dischargeDate },
    { item: 'Item 8 — Grade or rank at discharge', value: '[Your grade or rank at discharge]' },
    {
      item: 'Item 9 — Mailing address (includes phone and email)',
      value: '[Your mailing address, daytime phone number, and email address]',
    },
    { item: 'Item 10 — Character of service', value: characterizationLabel(input) },
    {
      item: 'Items 11a/11b — Prior applications / reconsideration',
      value: '[List any prior applications to this board, or check "No"]',
    },
    {
      item: 'Item 12 — Category of the request',
      value: '[Check the category matching a discharge-characterization change]',
    },
    {
      item: 'Item 13 — Correction or relief requested',
      value:
        `[Upgrade of my characterization of service from ${CHARACTERIZATION_LABELS[input.facts.characterization] ?? input.facts.characterization} — ` +
        'most mental-health petitions request Honorable or General (Under Honorable Conditions)]',
    },
    { item: 'Item 15 — Why this is an error or injustice', value: 'SEE ATTACHED STATEMENT' },
    { item: 'Items 23-25 — Counsel or representative', value: '[None, unless you have one]' },
    { item: 'Item 27a — Applicant signature', value: '[Sign by hand — unsigned applications are returned]' },
    { item: 'Item 27b — Date signed', value: '[The date you sign]' },
  ]
}

/** PURE: facts/routing → item-number rows for whichever form routing recommends. */
export function buildWorksheet(input: PacketInput): WorksheetRow[] {
  return input.routing.recommendedForm === 'DD149' ? dd149Rows(input) : dd293Rows(input)
}
