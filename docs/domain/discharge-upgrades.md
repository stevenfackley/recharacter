# Domain primer: military discharge upgrades

The curated legal/domain knowledge ReCharacter is built on. This is background for engineers — **it is not legal advice**, and the app never presents it as such.

## Characterizations of service

From best to worst: **Honorable** → **General (Under Honorable Conditions)** → **Other Than Honorable (OTH)** → **Bad Conduct Discharge (BCD**, from a court-martial**)** → **Dishonorable (DD**, general court-martial only**)**. Entry-level separations are **Uncharacterized**. An OTH or worse typically bars most VA benefits (GI Bill, home loan, often healthcare); an upgrade to General restores most of them. This is why upgrades matter — they restore benefits, healthcare, and honor.

## The two boards (per service branch)

| Route | Statute | Form | Window | Can review |
|-------|---------|------|--------|------------|
| **DRB** — Discharge Review Board | 10 U.S.C. §1553 | **DD Form 293** | **15 years** from discharge | characterization + narrative reason — but **NOT** discharges from a **general court-martial** |
| **BCMR/BCNR** — Board for Correction of Military/Naval Records | 10 U.S.C. §1552 | **DD Form 149** | 3 years from "discovery of the error," but the boards **routinely waive** this in the interest of justice — treat as always available | any record correction, incl. GCM discharges and everything the DRB can't touch |

| Branch | DRB | BCMR |
|--------|-----|------|
| Army | ADRB | ABCMR |
| Navy / Marine Corps | NDRB | BCNR |
| Air Force / Space Force | AFDRB | AFBCMR |
| Coast Guard | CGDRB | BCMR (DHS) |

Routing logic (implemented in `ReCharacter.RulesEngine`): within 15 years and not a GCM → DRB with DD-293; otherwise → BCMR with DD-149. A special court-martial BCD **is** DRB-reviewable; only *general* court-martial discharges are excluded. **Coast Guard is under DHS, not DoD** — its liberal-consideration policy is analogous but not identical (flagged in the engine; ships last).

## Liberal consideration — the product thesis

Three DoD memos direct the boards to give **favorable ("liberal") consideration** to upgrade petitions where a mental-health condition is connected to the misconduct behind the discharge:

- **Hagel memo (2014)** — liberal consideration for veterans claiming **PTSD** related to service, esp. Vietnam-era.
- **Kurta memo (2017)** — extends and operationalizes it: any **mental health condition** (PTSD, TBI, depression, adjustment disorder, …), **military sexual trauma (MST)**, and harassment; clarifies that a diagnosis is *not* required to apply and that evidence may come from the veteran alone.
- **Wilkie memo (2017)** — adds equity/clemency guidance: boards should also weigh positive service, combat, whole-person factors.

Because these are **DoD-wide policy, uniform across branches**, the MVP covers every branch with a single legal theory — branch is just a routing-table lookup.

### The Kurta memo's four questions

Every strong mental-health petition is an evidenced answer to these — they are the product's Nexus Builder:

1. Did the veteran have a condition or experience that may excuse or mitigate the discharge?
2. Did that condition exist / experience occur during military service?
3. Does that condition or experience actually excuse or mitigate the discharge?
4. Does that condition or experience outweigh the discharge?

The AI's job is to interview the veteran to fill these four board-defined slots and render them as prose — never to give open-ended advice.

## Evidence hierarchy (roughly strongest first)

1. **Clinician nexus letter** — a mental-health professional connecting the in-service condition to the misconduct. The single highest-leverage document.
2. **VA disability rating** for the condition (powerful corroboration that it exists and is service-connected).
3. **Service treatment records / in-service mental-health records.**
4. **Civilian mental-health records** (before/after service; shows trajectory).
5. **Buddy/witness statements** — sworn statements from people who observed the events or the change in the veteran. Critical when the in-service events were unreported or disbelieved.
6. **Personal statement** — the veteran's own narrative, structured around the four questions.
7. Post-service character evidence (employment, education, community) — mostly for Wilkie equity weight.

## Practical notes encoded in the product

- **A deadline miscalculation is the worst possible bug.** The DRB window is 15 years, deadline day inclusive; the engine resolves "today" at UTC-11 so it never prematurely declares a window closed for any U.S. veteran, and the BCMR path is always presented as available (with a waiver-likely advisory) rather than hard-closed.
- **Denied ≠ over.** A veteran denied at the DRB can generally reapply with new evidence or proceed to the BCMR; final BCMR denials can sometimes be challenged in federal court (out of product scope).
- **Uncharacterized (entry-level) separations** aren't derogatory, so there's nothing to "upgrade" in the characterization sense — but boards can still change them; the engine flags this case for tailored UX.
- **An upgrade petition is not a VA benefits claim** — related but separate processes; the app must never conflate them.

## Sources to verify against (before launch, with counsel)

- 10 U.S.C. §1552, §1553
- DoD Instruction 1332.28 (discharge review)
- Hagel memo (Sept 3, 2014); Kurta memo (Aug 25, 2017); Wilkie memo (July 25, 2018 — "guidance to boards regarding equity, injustice, or clemency")¹
- Current DD Form 293 / DD Form 149 revisions (esd.whs.mil)
- VA's online discharge-upgrade wizard (va.gov) — prior art for routing UX

¹ The Wilkie memo is commonly grouped with the 2017 guidance but was issued July 2018 — verify exact citations during the attorney-review gate.
