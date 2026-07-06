import type { PacketInput } from './sections'

/**
 * Item-number row tables for the two official forms. Every string here is
 * ATTORNEY-REVIEW SURFACE — item numbering per the official form's major
 * items (DD-293 DEC 2019 / DD-149 JAN 2023). We never collected name/SSN/
 * address/phone/email or a REQUESTED characterization anywhere in intake, so
 * those rows render bracketed placeholders for the veteran to fill in by
 * hand — never invented data. Long-form answers are attached, not
 * transcribed: "SEE ATTACHED STATEMENT" is standard practice for these forms.
 */

type WorksheetRow = { item: string; value: string }

const REQUESTED_CHARACTERIZATION_GUIDANCE =
  '[The characterization you are requesting — most mental-health petitions request Honorable ' +
  'or General (Under Honorable Conditions)]'

function dd293Rows(input: PacketInput): WorksheetRow[] {
  return [
    { item: "Item 1 — Applicant's full name", value: '[Your full legal name]' },
    { item: 'Item 2 — Social Security Number', value: '[Your Social Security Number]' },
    { item: 'Item 3 — Mailing address', value: '[Your mailing address]' },
    { item: 'Item 3a — Daytime telephone number', value: '[Your phone number]' },
    { item: 'Item 3b — Email address', value: '[Your email address]' },
    { item: 'Item 4 — Branch of service', value: input.facts.branch },
    { item: 'Item 5 — Date of discharge', value: input.facts.dischargeDate },
    { item: 'Item 5a — Unit or organization at discharge', value: '[Your unit or organization at discharge]' },
    { item: 'Item 6 — Character of discharge received', value: input.facts.characterization },
    { item: 'Item 7 — Character of discharge requested', value: REQUESTED_CHARACTERIZATION_GUIDANCE },
    { item: 'Item 8 — Issues and reasons for this request', value: 'SEE ATTACHED STATEMENT' },
    { item: 'Item 9 — Counsel or representative', value: '[None, unless you have one]' },
    {
      item: 'Item 10 — Prior applications to this or any other board',
      value: '[List any prior applications, or write "None"]',
    },
    { item: 'Item 11 — Applicant signature', value: '[Sign and date by hand]' },
    { item: 'Item 12 — Date signed', value: '[Sign and date by hand]' },
  ]
}

function dd149Rows(input: PacketInput): WorksheetRow[] {
  return [
    { item: "Item 1 — Applicant's full name", value: '[Your full legal name]' },
    { item: 'Item 2 — Social Security Number', value: '[Your Social Security Number]' },
    { item: 'Item 3 — Mailing address', value: '[Your mailing address]' },
    { item: 'Item 3a — Daytime telephone number', value: '[Your phone number]' },
    { item: 'Item 3b — Email address', value: '[Your email address]' },
    { item: 'Item 4 — Branch of service', value: input.facts.branch },
    { item: 'Item 5 — Date of discharge', value: input.facts.dischargeDate },
    { item: 'Item 6 — Organization or unit at time of discharge', value: '[Your unit or organization at discharge]' },
    {
      item: 'Item 7 — Record correction requested',
      value:
        `[Correct my discharge characterization from ${input.facts.characterization} to the ` +
        'characterization requested in the attached statement]',
    },
    { item: 'Item 8 — Error or injustice being corrected', value: 'SEE ATTACHED STATEMENT' },
    { item: 'Item 9 — Counsel or representative', value: '[None, unless you have one]' },
    {
      item: 'Item 10 — Prior applications to this or any other board',
      value: '[List any prior applications, or write "None"]',
    },
    { item: 'Item 11 — Applicant signature', value: '[Sign and date by hand]' },
    { item: 'Item 12 — Date signed', value: '[Sign and date by hand]' },
  ]
}

/** PURE: facts/routing → item-number rows for whichever form routing recommends. */
export function buildWorksheet(input: PacketInput): WorksheetRow[] {
  return input.routing.recommendedForm === 'DD149' ? dd149Rows(input) : dd293Rows(input)
}
