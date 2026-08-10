import { CORRIDOR_STATUS_NOTE } from '@prova/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { RevealOnScroll } from '@/components/reveal';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';

import '../marketing.css';

export const metadata: Metadata = {
  title: 'How it works — Prova',
  description:
    'From verifying your identity to settlement on Stellar: what happens at each step, what leaves your phone, and what the network can see.',
};

/**
 * How it works.
 *
 * Two levels on one page: the four steps a user actually performs, then a plain-language account of
 * the machinery underneath for anyone who wants to check the claims. The second half is what makes
 * the first half believable — "your data is safe" means nothing on its own, so this says exactly
 * what is transmitted at each step.
 */
export default function HowItWorksPage() {
  return (
    <>
      <RevealOnScroll />
      <SiteHeader />

      <main>
        <section className="hero hero-short">
          <div className="hero-glow" aria-hidden="true" />
          <div className="page">
            <span className="eyebrow reveal in">How it works</span>
            <h1 className="page-title reveal in">
              Four steps for you. <em>A lot</em> happening underneath.
            </h1>
            <p className="page-lede reveal in">
              Sending takes about a minute. Below is what you do, and then exactly what leaves your
              phone at each stage — so you can check the privacy claims rather than trust them.
            </p>
          </div>
        </section>

        {/* The user-facing journey */}
        <section className="section">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">What you do</span>
              <h2>Verify once. Then send in a minute.</h2>
            </div>

            <p className="scope-note">{CORRIDOR_STATUS_NOTE}</p>

            <div className="flow">
              {JOURNEY.map((step, i) => (
                <article
                  key={step.title}
                  className="card flow-step reveal"
                  style={{ '--delay': `${i * 80}ms` } as React.CSSProperties}>
                  <span className="flow-num">{String(i + 1).padStart(2, '0')}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                  <p className="flow-time">{step.time}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* What is actually transmitted */}
        <section className="section">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">Under the hood</span>
              <h2>What leaves your phone, step by step.</h2>
              <p>
                This is the table worth checking. If any row said &ldquo;your amount&rdquo; or
                &ldquo;your documents&rdquo;, the rest of this site would be marketing.
              </p>
            </div>

            <div className="table-wrap reveal">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Leaves your phone</th>
                    <th>Stays on your phone</th>
                  </tr>
                </thead>
                <tbody>
                  {TRANSMISSION.map((row) => (
                    <tr key={row.step}>
                      <td>{row.step}</td>
                      <td>{row.sent}</td>
                      <td>{row.kept}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* The mechanisms */}
        <section className="section">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">The three ideas</span>
              <h2>How a transfer can be private and still provable.</h2>
            </div>

            <div className="grid-3">
              {MECHANISMS.map((item, i) => (
                <article
                  key={item.title}
                  className="card feature reveal"
                  style={{ '--delay': `${i * 90}ms` } as React.CSSProperties}>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">Straight answers</span>
              <h2>The questions people actually ask.</h2>
            </div>

            <div className="faq reveal">
              {FAQ.map((item) => (
                <details key={item.q} className="faq-item">
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="page">
            <div className="cta reveal">
              <h2>Still have a question?</h2>
              <p>Ask us directly — or read the source and check for yourself.</p>
              <Link className="btn btn-primary" href="/contact">
                Contact us
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}

const JOURNEY = [
  {
    title: 'Verify your identity',
    body: 'Photograph your ID and complete a short liveness check. A member of our team reviews it. Approval puts a credential on your phone that says only that you are verified, your tier, and when it expires.',
    time: 'Once · usually reviewed within 24 hours',
  },
  {
    title: 'Add money',
    body: 'Top up your balance, then move it into your private balance. This step is public on purpose — the institution you deposited with already knows, so hiding it would buy you nothing.',
    time: 'A few seconds to confirm',
  },
  {
    title: 'Send',
    body: 'Choose a recipient and an amount. Your phone builds the proof that the transfer is valid and allowed. This is the slow part, and it is still about two and a half seconds.',
    time: '≈ 2.6 seconds to prove',
  },
  {
    title: 'They receive',
    body: 'The transfer settles on Stellar and the money appears in the recipient’s private balance, ready for them to send onward.',
    time: '≈ 5 seconds to settle',
  },
];

const TRANSMISSION = [
  {
    step: 'Signing in',
    sent: 'Your email address, to send you a one-time code',
    kept: 'Your PIN, and every key derived from it',
  },
  {
    step: 'Verifying identity',
    sent: 'An opaque identifier and which documents you captured — no images',
    kept: 'Photographs of your ID and your face; they are read on-device',
  },
  {
    step: 'Adding money',
    sent: 'A public deposit to the pool: a commitment and a proof it is well-formed',
    kept: 'The note that lets you spend it, and its blinding value',
  },
  {
    step: 'Sending',
    sent: 'A proof, a nullifier, and two commitments — no amount, no names',
    kept: 'The amount, the recipient, your keys, your credential',
  },
  {
    step: 'Your history',
    sent: 'Nothing. The Activity screen is built from your own device',
    kept: 'Every transaction you have made',
  },
];

const MECHANISMS = [
  {
    title: 'Zero-knowledge proofs',
    body: 'A proof convinces the network that a statement is true without revealing why. Yours says: this money exists, it has not been spent before, I am allowed to send it, and I am within my limit. It does not say who, or how much.',
  },
  {
    title: 'A shielded pool',
    body: 'Money in the pool is held as commitments — sealed values nobody can open but the owner. Spending one publishes a nullifier that proves it is now used, without ever pointing back to which commitment it was.',
  },
  {
    title: 'A credential, not an identity',
    body: 'Approval issues your device a signed statement that you are verified. Your transfer proves it holds a valid one; it never attaches it. So the network can enforce the rules without learning who is following them.',
  },
];

const FAQ = [
  {
    q: 'If you cannot see amounts, how do you stop money laundering?',
    a: 'Every transfer must include a proof that the sender holds a valid, unexpired verification credential and is inside the transfer limit for their tier. The contract rejects anything without one. So the rules are enforced on every single transfer — more consistently than a system that checks a database after the fact — without the network learning who is behind it.',
  },
  {
    q: 'What happens if I lose my phone?',
    a: 'If you set up cloud backup, you can restore with your PIN — the backup is encrypted on your device before it leaves, so neither the storage provider nor we can read it. Without a backup, the money cannot be recovered by anyone, including us. That is the direct cost of us never holding your keys, and it is not something we can waive for individual users.',
  },
  {
    q: 'Can you freeze or reverse my transfer?',
    a: 'No. A transfer confirmed on a public blockchain is final. We can decline to relay one, and we can revoke a verification so no future transfer proves valid, but we cannot claw back money that has settled.',
  },
  {
    q: 'Why is adding money public when everything else is private?',
    a: 'Because the institution you deposited with already saw it. Hiding a deposit from the chain while the bank has it on record would add complexity and buy no real privacy. What matters is that the link between your deposit and your later transfers is broken — and that is exactly what the pool does.',
  },
  {
    q: 'Is my money safe on a test network?',
    a: 'There is no money on a test network. Balances are test assets with no monetary value, and the network can be reset without warning. Treat this build as something to try, not somewhere to keep savings.',
  },
  {
    q: 'Who can see that I use Prova at all?',
    a: 'The institutions you deposit and withdraw through, since that is where money enters and leaves the regulated system. Between those two points, what you do is not visible to us or to anyone reading the chain.',
  },
];
