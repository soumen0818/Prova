import { CORRIDOR_STATUS_NOTE } from '@prova/shared';

import { GetAppButton } from '@/components/get-app-button';
import { GetTheApp } from '@/components/get-the-app';
import { PhoneMock } from '@/components/phone-mock';
import { RevealOnScroll } from '@/components/reveal';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';

import './marketing.css';

/**
 * The marketing home page.
 *
 * Every claim here is one this build actually delivers, and where something is not yet true — the
 * corridor is on a test network, verification is reviewed by a person — the page says so rather than
 * implying a live service. A remittance product asking migrant workers for trust cannot open the
 * relationship by overstating what it does.
 */
export default function HomePage() {
  return (
    <>
      <RevealOnScroll />
      <SiteHeader />

      <main>
        <section className="hero">
          <div className="hero-glow" aria-hidden="true" />
          <div className="page hero-grid">
            <div>
              <span className="eyebrow reveal in">Midnight privacy · Stellar settlement</span>
              <h1 className="reveal in">
                Send money home <em>without</em> broadcasting it.
              </h1>
              <p
                className="hero-sub reveal in"
                style={{ '--delay': '80ms' } as React.CSSProperties}>
                Private transfers work on Stellar testnet today. Midnight credential proofs are
                built and tested, with the app-to-Midnight connection still in progress.
              </p>
              <div
                className="hero-actions reveal in"
                style={{ '--delay': '160ms' } as React.CSSProperties}>
                <GetAppButton className="btn btn-primary" />
                <a className="btn btn-ghost" href="#how">
                  See how it works
                </a>
              </div>
              <p
                className="hero-note reveal in"
                style={{ '--delay': '220ms' } as React.CSSProperties}>
                On the Stellar test network with test assets. {CORRIDOR_STATUS_NOTE}
              </p>
            </div>

            <PhoneMock />
          </div>
        </section>

        <section className="section" id="networks">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">Two networks, distinct jobs</span>
              <h2>Privacy on Midnight. Settlement on Stellar.</h2>
              <p>
                This is the architecture we are building. The current Android app settles private
                test transfers on Stellar; it does not yet require a Midnight decision.
              </p>
            </div>
            <div className="grid-2">
              <article className="card feature reveal">
                <h3>Midnight · eligibility</h3>
                <p>
                  Our Compact contract proves that an issuer-signed credential meets a public KYC
                  policy without publishing its contents. It has 39 recorded passing tests and an
                  initial Preprod deployment. Product integration and a managed deployment remain
                  open.
                </p>
                <a
                  className="inline-link"
                  href="https://github.com/soumen0818/Prova/tree/main/privacy/midnight">
                  Inspect the contract and tests →
                </a>
              </article>
              <article className="card feature reveal">
                <h3>Stellar · value</h3>
                <p>
                  The Android app uses a Soroban shielded pool for testnet transfers. Stellar holds
                  the test assets and verifies the existing spend proof. It does not yet enforce a
                  Midnight authorization.
                </p>
                <a
                  className="inline-link"
                  href="https://github.com/soumen0818/Prova/blob/main/contracts/DEPLOYMENTS.md">
                  See Stellar contract references →
                </a>
              </article>
            </div>
          </div>
        </section>

        <section className="section" id="privacy">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">Private by construction</span>
              <h2>Private transfer details, with clear limits.</h2>
              <p>
                The Stellar proof hides amounts and recipients in the shielded transfer. Identity
                approval is still a testnet demo, not a licensed KYC check.
              </p>
            </div>

            <div className="grid-3">
              {FEATURES.map((feature, i) => (
                <article
                  key={feature.title}
                  className="card feature reveal"
                  style={{ '--delay': `${i * 90}ms` } as React.CSSProperties}>
                  <div className="feature-icon" aria-hidden="true">
                    {feature.glyph}
                  </div>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="how">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">How it works</span>
              <h2>Four steps on testnet.</h2>
              <p>
                Proof generation runs on the phone. Timing varies by device and network, and the
                Midnight proof is not yet part of the app journey.
              </p>
            </div>

            <div className="steps">
              {STEPS.map((step, i) => (
                <div
                  key={step.title}
                  className="step reveal"
                  style={{ '--delay': `${i * 80}ms` } as React.CSSProperties}>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="compliance">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">Compliance</span>
              <h2>Test credentials today; private eligibility next.</h2>
              <p>
                The current Stellar proof checks a signed test credential and transfer rules. The
                Midnight contract separately tests private credential eligibility; it does not yet
                authorize transfers from this app. No licensed identity provider is connected.
              </p>
            </div>

            <div className="grid-2">
              {COMPLIANCE.map((item, i) => (
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
          <div className="page stats">
            {STATS.map((stat, i) => (
              <div
                key={stat.label}
                className="reveal"
                style={{ '--delay': `${i * 70}ms` } as React.CSSProperties}>
                <div className="stat-value">{stat.value}</div>
                <div className="stat-label">{stat.label}</div>
              </div>
            ))}
          </div>
        </section>

        <GetTheApp />
      </main>

      <SiteFooter />
    </>
  );
}

const FEATURES = [
  {
    glyph: '◆',
    title: 'The amount stays on your phone',
    body: 'A transfer publishes a commitment and a proof. No amount is ever transmitted to Prova, so there is no ledger of what you send for anyone to leak, subpoena or sell.',
  },
  {
    glyph: '◇',
    title: 'No documents in this demo',
    body: 'The current test credential flow does not request ID photos. A licensed identity-check provider is not yet connected.',
  },
  {
    glyph: '○',
    title: 'Your keys, held by you',
    body: 'Spending keys are generated in your phone’s secure hardware and never leave it. We cannot move your money, freeze it, or recover it for you — and neither can anyone who compromises us.',
  },
];

const STEPS = [
  {
    title: 'Get a test credential',
    body: 'Request a demo approval in the app. An operator may approve it, but no identity document is checked.',
  },
  {
    title: 'Add money',
    body: 'Add test assets, then move them into your private balance. This is not a bank deposit.',
  },
  {
    title: 'Prove and send',
    body: 'Your phone builds a zero-knowledge spend proof. Proving time depends on the device.',
  },
  {
    title: 'They receive',
    body: 'Settlement lands on Stellar in seconds. What the network records reveals no amount and no names.',
  },
];

const COMPLIANCE = [
  {
    title: 'A private credential proof',
    body: 'Midnight can prove an issuer-signed credential meets a KYC policy without revealing its contents. This contract is tested, but not yet connected to the app.',
  },
  {
    title: 'Limits enforced by the network',
    body: 'Tier limits are checked inside the proof, not by the app. A modified client cannot exceed them, because the contract will not accept a proof that says otherwise.',
  },
  {
    title: 'Credentials expire',
    body: 'The test credential has an expiry. Automated renewal is not a substitute for a licensed identity check; the real provider workflow remains to be built.',
  },
  {
    title: 'An audit trail that holds no identities',
    body: 'The backend records demo approval decisions and their status changes. These records document operator actions, not a completed document review.',
  },
];

const STATS = [
  { value: '~2.6s', label: 'Proof built on a mid-range phone' },
  { value: '5s', label: 'Typical settlement on Stellar' },
  { value: '0', label: 'Amounts stored on our servers' },
  { value: '39', label: 'Recorded passing Midnight tests' },
];
