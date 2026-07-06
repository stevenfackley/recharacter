import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms of Service" };

// DRAFT — attorney review required before launch (docs/legal-review-package.md §7).
export default function TermsPage() {
  return (
    <main>
      <h1>Terms of Service</h1>
      <p role="alert">
        DRAFT — pending review by licensed counsel. Not yet in effect.
      </p>
      <h2>What ReCharacter is</h2>
      <p>
        ReCharacter is a document-assembly and process-information tool for
        veterans preparing discharge-upgrade petitions. It is not a law firm,
        does not provide legal advice or representation, and never files
        anything on your behalf. Every document it produces is a draft you
        review, edit, own, and decide whether to file.
      </p>
      <h2>Your account and content</h2>
      <p>
        Your records, answers, and drafts belong to you. You are responsible
        for the accuracy of the facts you confirm and for everything you file
        with any review board.
      </p>
      <h2>No outcome promises</h2>
      <p>
        Board decisions belong to the boards. Nothing in this product predicts,
        promises, or guarantees any outcome.
      </p>
      <h2>Payments</h2>
      <p>
        The one-time unlock is a software fee for drafting and packet-assembly
        features. Bring-your-own-key use runs on your own AI provider account
        and its terms.
      </p>
    </main>
  );
}
