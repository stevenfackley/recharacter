import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy" };

// DRAFT — attorney review required before launch (docs/legal-review-package.md §7).
export default function PrivacyPage() {
  return (
    <main>
      <h1>Privacy</h1>
      <p role="alert">
        DRAFT — pending review by licensed counsel. Not yet in effect.
      </p>
      <h2>What we hold, and why</h2>
      <p>
        Your service facts, uploaded records, answers, and drafts exist for one
        purpose: assembling your petition. Every row and file is isolated to
        your account — enforced in the database itself, not just the
        application.
      </p>
      <h2>Where AI processing happens</h2>
      <p>
        When you use AI features on our managed tier, the text you provide is
        sent to Anthropic&apos;s API, which does not train on API traffic by
        default. If you add your own API key, AI requests run on your own
        Anthropic account and never touch ours.
      </p>
      <h2>What we never do</h2>
      <p>
        We do not sell your data, train models on your story, or share your
        records with boards, the VA, or anyone else. Filing is yours alone.
      </p>
      <h2>Deletion</h2>
      <p>
        Delete your account and your records go with it. (One-click export and
        deletion controls are part of the launch checklist.)
      </p>
    </main>
  );
}
