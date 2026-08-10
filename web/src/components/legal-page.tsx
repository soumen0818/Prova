import { LEGAL_DOCS, type LegalDocId } from '@prova/shared';

import { SiteFooter, SiteHeader } from '@/components/site-chrome';

import '@/app/marketing.css';

/**
 * Renders a legal document from the shared definitions.
 *
 * The wording comes from `@prova/shared`, the same module the app's Legal screen reads, so the
 * published policy and the in-app policy cannot drift apart. That is not tidiness — a policy that
 * says different things in two places is unenforceable and, if the difference matters, dishonest.
 */
export function LegalPage({ id }: { id: LegalDocId }) {
  const doc = LEGAL_DOCS[id];

  return (
    <>
      <SiteHeader />
      <main className="page legal">
        <h1>{doc.title}</h1>
        <p className="legal-updated">Last updated {doc.updated}</p>
        <p className="legal-intro">{doc.intro}</p>

        {doc.sections.map((section) => (
          <section key={section.heading}>
            <h2>{section.heading}</h2>
            {section.body.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </section>
        ))}

        <p className="legal-contact">{doc.contact}</p>
      </main>
      <SiteFooter />
    </>
  );
}
