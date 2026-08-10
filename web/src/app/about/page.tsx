import { CORRIDOR_STATUS_NOTE } from '@prova/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

import { RevealOnScroll } from '@/components/reveal';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import { CORRIDOR, REPO_URL } from '@/lib/site';

import '../marketing.css';

export const metadata: Metadata = {
  title: 'About — Prova',
  description:
    'Why Prova exists: remittance corridors where every transfer is public, and what it takes to fix that without abandoning compliance.',
};

/**
 * The About page.
 *
 * Written to answer "who is behind this and why should I believe them", which for a money product
 * is the only question that matters. It says plainly that this is early, small, and on a test
 * network — a page that oversold a one-person testnet build would undermine the exact trust it is
 * trying to earn.
 */
export default function AboutPage() {
  return (
    <>
      <RevealOnScroll />
      <SiteHeader />

      <main>
        <section className="hero hero-short">
          <div className="hero-glow" aria-hidden="true" />
          <div className="page">
            <span className="eyebrow reveal in">About Prova</span>
            <h1 className="page-title reveal in">
              Sending money home should not mean <em>publishing</em> it.
            </h1>
            <p className="page-lede reveal in">
              Prova is a remittance app for the {CORRIDOR} corridor, built on the idea that privacy
              and compliance are not opposites — you can prove a transfer is legitimate without
              revealing who made it or what it was worth.
            </p>
          </div>
        </section>

        <section className="section">
          <div className="page prose">
            <div className="reveal">
              <h2>The problem</h2>
              <p>
                Millions of people work abroad and send money to their families every month. The
                systems that carry it are expensive, slow, and — as they move onto public
                blockchains — permanently visible. A transfer on a typical chain records the sender,
                the recipient and the exact amount, forever, for anyone to read.
              </p>
              <p>
                That is not a small privacy inconvenience. It means a stranger can see what a
                domestic worker earns, when they were paid, who depends on them, and how much they
                have left. Financial surveillance of the people least able to object to it.
              </p>
            </div>

            <div className="reveal">
              <h2>Why the usual answer fails</h2>
              <p>
                The obvious fix is a private chain or a mixer — and that is exactly where these
                products die. A regulated remittance corridor cannot be built on a system that makes
                compliance impossible. No licensed institution will move money into something it
                cannot demonstrate is clean, and no regulator will allow it to.
              </p>
              <p>
                So the interesting problem is not "how do we hide transfers". It is{' '}
                <strong>how do we prove a transfer is compliant without revealing it</strong>.
              </p>
            </div>

            <div className="reveal">
              <h2>What Prova does about it</h2>
              <p>
                Your phone builds a zero-knowledge proof that you are verified, within your limit,
                and that your verification has not expired. The network checks the proof and settles
                the transfer. It never learns the amount, the recipient, or who you are — because
                the proof carries none of that, and there is deliberately no endpoint on our side
                that could receive it.
              </p>
              <p>
                Concretely: your keys are generated in your phone&rsquo;s secure hardware and never
                leave it. Your identity documents are read on the device and never uploaded. Amounts
                are never transmitted to us. We are not promising to be careful with your data — we
                have built a system that mostly cannot have it in the first place, which is a much
                stronger guarantee than a policy.
              </p>
            </div>

            <div className="reveal">
              <h2>Where it is today</h2>
              <p>
                Honestly: early. Prova runs on the Stellar test network with test assets that have
                no monetary value. Identity verification is reviewed by a person rather than a
                licensed vendor, because until that vendor is integrated, auto-approving would be
                telling people they are verified on the strength of no check at all.
              </p>
              <p>{CORRIDOR_STATUS_NOTE}</p>
              <p>
                It is built and maintained by a very small team. That is a reason to read the code
                rather than take our word for anything — the cryptography, the contracts and the app
                are all public.
              </p>
              <p>
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-link">
                  Read the source on GitHub →
                </a>
              </p>
            </div>

            <div className="reveal">
              <h2>What we will not do</h2>
              <ul className="plain-list">
                <li>Hold your keys, or build any way to move your money without you.</li>
                <li>Ask for your PIN or recovery phrase. Nobody at Prova will, ever.</li>
                <li>Collect identity documents onto our servers.</li>
                <li>Sell, share or monetise transaction data — we do not have it to sell.</li>
                <li>Claim to be licensed, live, or handling real money before we are.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="page">
            <div className="cta reveal">
              <h2>Questions about any of this?</h2>
              <p>
                We would rather answer a hard question than have you assume the flattering version.
              </p>
              <Link className="btn btn-primary" href="/contact">
                Get in touch
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
