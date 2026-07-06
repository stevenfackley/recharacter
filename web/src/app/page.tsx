import Link from "next/link";

// The public landing page. Copy rules: plain verbs, specific claims, no
// outcome promises — this audience deserves straight talk, and the legal
// posture (document assembly, not legal advice) holds on the marketing
// surface too. All copy here is attorney-review surface before launch.

export default function Home() {
  return (
    <main className="land">
      <section className="hero">
        <div>
          <h1>Your discharge doesn&apos;t get the last word.</h1>
          <p className="lede">
            If a mental-health condition or what you went through in service is
            connected to the conduct behind your discharge, the review boards
            are directed to weigh that in your favor. ReCharacter walks you
            through building that petition — step by step, in your own words.
          </p>
          <div className="cta-row">
            <Link className="button-link" href="/signup">
              Start your case — free
            </Link>
            <a className="button-link quiet" href="#how">
              See how it works
            </a>
          </div>
        </div>
        <div className="record-card" aria-label="Example of a recharacterized discharge">
          <span className="field-label">CHARACTER OF SERVICE</span>
          <span className="stamp struck">UNDER OTHER THAN HONORABLE CONDITIONS</span>
          <br />
          <span className="stamp granted">GENERAL (UNDER HONORABLE CONDITIONS)</span>
          <span className="card-footnote">
            RECHARACTERIZATION · DD FORM 293 · LIBERAL CONSIDERATION REQUESTED
          </span>
        </div>
      </section>

      <section id="how">
        <h2>How it works</h2>
        <ol className="steps">
          <li>
            <div>
              <strong>Add your service facts</strong>
              <p>
                Upload your DD-214 — we read it and you confirm every field —
                or type four facts yourself. Nothing moves forward without your
                sign-off.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>See exactly where your case goes</strong>
              <p>
                Branch, discharge date, and characterization determine your
                board, your form (DD 293 or DD 149), and your filing deadline.
                Computed, not guessed.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Build your evidence</strong>
              <p>
                A checklist personalized to your situation, a completeness
                score, and the single highest-value document to go get next.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Answer the four questions boards actually weigh</strong>
              <p>
                The review boards are directed to consider four specific
                questions in mental-health cases. You answer each in your own
                words — with optional help phrasing them clearly.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Draft your statement</strong>
              <p>
                Your four answers become a complete personal statement and
                cover letter. You read every word, edit anything, and own the
                result.
              </p>
            </div>
          </li>
          <li>
            <div>
              <strong>Download your filing packet</strong>
              <p>
                One PDF: cover letter, statement, evidence index, and a
                worksheet mapping every answer to the official form&apos;s item
                numbers. You fill the official form, sign it, and file it.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section>
        <h2>What&apos;s free, and what isn&apos;t</h2>
        <div className="tiers">
          <div className="tier">
            <h3>ALWAYS FREE</h3>
            <ul>
              <li>Reading your DD-214</li>
              <li>Your board, form, and deadline</li>
              <li>The personalized evidence checklist and score</li>
              <li>The four questions, answered in your own words</li>
            </ul>
          </div>
          <div className="tier">
            <h3>ONE-TIME UNLOCK</h3>
            <ul>
              <li>AI help phrasing your answers</li>
              <li>Statement and cover-letter drafting</li>
              <li>The assembled filing packet</li>
              <li>
                Or bring your own Anthropic API key — then everything above is
                included at no extra charge
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="posture">
        <p>
          <strong>Straight talk:</strong> ReCharacter is document assembly and
          process information — not a law firm, and not legal advice. We never
          predict what a board will decide, and nothing is filed unless you
          file it.
        </p>
        <p>
          Your story stays yours: your records are visible only to you, and
          you can use your own AI account so drafts never touch ours.
        </p>
      </section>

      <section>
        <h2>Common questions</h2>
        <details>
          <summary>Do I need a diagnosis to apply?</summary>
          <p>
            No. The boards&apos; own guidance says a formal diagnosis is not
            required to apply — your account of what happened matters, and the
            app helps you organize it.
          </p>
        </details>
        <details>
          <summary>My discharge was years ago. Is it too late?</summary>
          <p>
            Often not. Discharge Review Boards take applications for 15 years;
            after that, the correction boards routinely accept late
            applications in the interest of justice. Enter your facts and the
            app computes your actual window.
          </p>
        </details>
        <details>
          <summary>Does an upgrade change my VA benefits?</summary>
          <p>
            A characterization upgrade commonly restores eligibility for
            benefits an OTH blocks — but a petition and a VA claim are separate
            processes. This app prepares the petition.
          </p>
        </details>
        <details>
          <summary>Who can see what I write?</summary>
          <p>
            Only you. Every record is isolated to your account, drafts are
            yours to edit or delete, and with your own API key the AI never
            runs on our account at all.
          </p>
        </details>
      </section>

      <section>
        <h2>Start where you are</h2>
        <p>
          Ten minutes gets your facts in, your board identified, and your
          deadline on the calendar.
        </p>
        <div className="cta-row">
          <Link className="button-link" href="/signup">
            Start your case — free
          </Link>
          <Link className="button-link quiet" href="/login">
            Sign back in
          </Link>
        </div>
      </section>
    </main>
  );
}
