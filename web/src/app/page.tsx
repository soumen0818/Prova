import { CORRIDOR_STATUS_NOTE } from '@prova/shared';

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
              <span className="eyebrow reveal in">UAE → India · Stellar</span>
              <h1 className="reveal in">
                Send money home <em>without</em> broadcasting it.
              </h1>
              <p
                className="hero-sub reveal in"
                style={{ '--delay': '80ms' } as React.CSSProperties}>
                Prova proves your transfer is compliant on your own phone. The amount, the recipient
                and your documents never leave it — only a proof does.
              </p>
              <div
                className="hero-actions reveal in"
                style={{ '--delay': '160ms' } as React.CSSProperties}>
                <a className="btn btn-primary" href="#get-the-app">
                  Get the app
                </a>
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

        <section className="section" id="privacy">
          <div className="page">
            <div className="section-head reveal">
              <span className="eyebrow">Private by construction</span>
              <h2>Nobody sees your money — including us.</h2>
              <p>
                Privacy here is not a policy we promise to keep. It is what the system is physically
                able to know, which is almost nothing.
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
              <h2>Four steps, about a minute.</h2>
              <p>
                The heavy work — proving you are allowed to send this — happens on the phone in your
                hand, in a couple of seconds.
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
              <h2>Private does not mean unaccountable.</h2>
              <p>
                Every transfer carries a proof that the sender is verified, within their limit, and
                that their verification has not expired. The proof is checked by the network. What
                it does not carry is who they are.
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
    title: 'Your documents never upload',
    body: 'Identity checks run on the device. Photos of your ID and your face are read where they were taken and are not sent to us — there is deliberately no endpoint that could receive them.',
  },
  {
    glyph: '○',
    title: 'Your keys, held by you',
    body: 'Spending keys are generated in your phone’s secure hardware and never leave it. We cannot move your money, freeze it, or recover it for you — and neither can anyone who compromises us.',
  },
];

const STEPS = [
  {
    title: 'Verify once',
    body: 'Confirm your identity in the app. A person on our team reviews it, usually well within 24 hours.',
  },
  {
    title: 'Add money',
    body: 'Top up, then move it into your private balance. That step is public by design — the anchor already knows.',
  },
  {
    title: 'Prove and send',
    body: 'Your phone builds a zero-knowledge proof in a couple of seconds. Only the proof is submitted.',
  },
  {
    title: 'They receive',
    body: 'Settlement lands on Stellar in seconds. What the network records reveals no amount and no names.',
  },
];

const COMPLIANCE = [
  {
    title: 'Verified, without identifying you',
    body: 'Approval issues a credential to your device saying only that you are verified, your tier, and when it expires. Your transfer proves it holds a valid one — it does not attach it.',
  },
  {
    title: 'Limits enforced by the network',
    body: 'Tier limits are checked inside the proof, not by the app. A modified client cannot exceed them, because the contract will not accept a proof that says otherwise.',
  },
  {
    title: 'Credentials expire',
    body: 'A credential lives on a phone and cannot be revoked remotely, so it is short-lived by design. Renewal re-screens, which bounds how long a stale approval can be used.',
  },
  {
    title: 'An audit trail that holds no identities',
    body: 'Every verification decision is recorded immutably — what changed, when, and who decided. The subject is an opaque hash, so the trail proves the process without exposing the person.',
  },
];

const STATS = [
  { value: '~2.6s', label: 'Proof built on a mid-range phone' },
  { value: '5s', label: 'Typical settlement on Stellar' },
  { value: '0', label: 'Amounts stored on our servers' },
  { value: '0', label: 'Documents uploaded to us' },
];
