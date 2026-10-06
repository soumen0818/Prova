import { CORRIDOR_STATUS_NOTE } from '@prova/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { RevealOnScroll } from '@/components/reveal';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';

import '../marketing.css';

export const metadata: Metadata = {
  title: 'How it works — Prova',
  description:
    'How the current Stellar testnet transfer works, where Midnight fits, and what remains unfinished.',
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
              Below is the current Stellar testnet journey and what leaves your phone. Midnight
              credential proving is a separate component that is not yet wired into this app.
            </p>
          </div>
        </section>

        {/* The user-facing journey */}
        <section className="section">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">What you do</span>
              <h2>Request a test credential. Then send on testnet.</h2>
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
                This table describes the current app. The credential approval is a demo workflow; no
                identity document is checked by a reviewer or provider.
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
    title: 'Request a test credential',
    body: 'Ask for a demo credential in the app. An operator may approve it, but this build does not perform a licensed ID check or request document photos.',
    time: 'Approval time depends on the test operator',
  },
  {
    title: 'Add money',
    body: 'Add test assets, then move them into your private balance. This is not a real bank deposit.',
    time: 'A few seconds to confirm',
  },
  {
    title: 'Send',
    body: 'Choose a recipient and an amount. Your phone builds a Stellar spend proof. Time varies by device; a Midnight eligibility proof is not yet part of this app step.',
    time: 'Proof time varies by device',
  },
  {
    title: 'They receive',
    body: 'The transfer settles on Stellar and the money appears in the recipient’s private balance, ready for them to send onward.',
    time: 'Settlement time varies by network',
  },
];

const TRANSMISSION = [
  {
    step: 'Signing in',
    sent: 'Your email address, to send you a one-time code',
    kept: 'Your PIN, and every key derived from it',
  },
  {
    step: 'Requesting a test credential',
    sent: 'Your signed-in account and an opaque wallet identifier',
    kept: 'Your wallet secret; no ID photos are requested',
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
    body: 'A demo approval issues a signed test credential to your device. The Stellar proof uses it today; the separate Midnight eligibility decision is not yet enforced by settlement.',
  },
];

const FAQ = [
  {
    q: 'If you cannot see amounts, how do you stop money laundering?',
    a: 'The Stellar testnet contract checks a signed test credential and transfer limits inside its proof. This demonstrates the mechanism, but the current demo approval is not a licensed identity or sanctions check. A real-money service needs a qualified provider and regulated partners.',
  },
  {
    q: 'What happens if I lose my phone?',
    a: 'If you set up cloud backup, you can restore with your PIN — the backup is encrypted on your device before it leaves, so neither the storage provider nor we can read it. Without a backup, the money cannot be recovered by anyone, including us. That is the direct cost of us never holding your keys, and it is not something we can waive for individual users.',
  },
  {
    q: 'Can you freeze or reverse my transfer?',
    a: 'No. A transfer confirmed on a public blockchain is final. We can decline to relay a new test transfer, but cannot claw back one that has settled.',
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
