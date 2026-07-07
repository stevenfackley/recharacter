import type { Metadata } from "next";
import { Zilla_Slab, Public_Sans, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

// Public Sans is the U.S. government's own open typeface (USWDS) — used here
// deliberately: the same letterforms that set the forms, working for the
// veteran's side of the desk. Zilla Slab carries headings; Plex Mono carries
// the document vernacular (dates, item numbers, stamps).
const displayFont = Zilla_Slab({
  variable: "--font-display",
  weight: ["500", "600"],
  subsets: ["latin"],
});

const bodyFont = Public_Sans({
  variable: "--font-body",
  weight: ["400", "600"],
  subsets: ["latin"],
});

const monoFont = IBM_Plex_Mono({
  variable: "--font-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://recharacter.us"),
  title: {
    default: "ReCharacter",
    template: "%s — ReCharacter",
  },
  description:
    "Build your discharge-upgrade petition: routing, evidence, the four questions boards weigh, and a filing-ready packet you own.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      <body>
        <header className="site-header">
          <Link href="/case" className="wordmark">
            <span className="wordmark-re">Re</span>Character
          </Link>
          <nav aria-label="Primary">
            <Link href="/case">Your case</Link>
            <Link href="/settings/ai">AI settings</Link>
          </nav>
        </header>
        {children}
        <footer className="site-footer">
          Document assembly, not legal advice. You decide what to file, and you
          file it yourself.
          <span className="footer-links">
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </span>
        </footer>
      </body>
    </html>
  );
}
