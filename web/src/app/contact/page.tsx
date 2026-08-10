import type { Metadata } from 'next';

import { RevealOnScroll } from '@/components/reveal';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';
import {
  CONTACT_EMAIL,
  CORRIDOR,
  PHONE,
  POSTAL_ADDRESS,
  REPO_URL,
  RESPONSE_TIME,
} from '@/lib/site';

import { ContactForm } from './contact-form';
import '../marketing.css';

export const metadata: Metadata = {
  title: 'Contact — Prova',
  description: `Get in touch with the Prova team. Email ${CONTACT_EMAIL}, or send us a message and we will reply ${RESPONSE_TIME}.`,
};

/**
 * The contact page.
 *
 * Deliberately more than a form. A form on its own tells a reader nothing about whether anyone is
 * behind it — for a money product, the details beside it (a real address to write to, how long a
 * reply takes, where to go if the app itself is the problem) are what make the form worth filling
 * in.
 */
export default function ContactPage() {
  return (
    <>
      <RevealOnScroll />
      <SiteHeader />

      <main>
        <section className="hero hero-short">
          <div className="hero-glow" aria-hidden="true" />
          <div className="page">
            <span className="eyebrow reveal in">Contact</span>
            <h1 className="page-title reveal in">Talk to a person.</h1>
            <p className="page-lede reveal in">
              A small team reads everything sent here, and answers {RESPONSE_TIME}. There is no
              ticket queue and no bot in between.
            </p>
          </div>
        </section>

        <section className="section">
          <div className="page contact-grid">
            <div className="reveal">
              <h2 className="contact-h2">Send us a message</h2>
              <ContactForm />
            </div>

            <div
              className="contact-details reveal"
              style={{ '--delay': '90ms' } as React.CSSProperties}>
              <h2 className="contact-h2">Our details</h2>

              <div className="detail">
                <h3>Email</h3>
                <p>
                  <a href={`mailto:${CONTACT_EMAIL}`} className="inline-link">
                    {CONTACT_EMAIL}
                  </a>
                </p>
                <p className="detail-note">
                  General questions, partnerships, press, and anything about your account.
                </p>
              </div>

              <div className="detail">
                <h3>Already using the app?</h3>
                <p>
                  Open Prova and go to <strong>Profile → Chat with us</strong>.
                </p>
                <p className="detail-note">
                  Faster than email, and it reaches the same team. Your messages appear in the app,
                  so you can pick the conversation back up on any screen.
                </p>
              </div>

              <div className="detail">
                <h3>Response time</h3>
                <p>Usually a few hours, always {RESPONSE_TIME}.</p>
                <p className="detail-note">
                  Identity verification is reviewed on the same clock — if you have been waiting
                  longer than a day, please chase us.
                </p>
              </div>

              <div className="detail">
                <h3>Corridor</h3>
                <p>{CORRIDOR}</p>
                <p className="detail-note">
                  Running on the Stellar test network. Test assets only — they have no monetary
                  value.
                </p>
              </div>

              {POSTAL_ADDRESS ? (
                <div className="detail">
                  <h3>Post</h3>
                  <p style={{ whiteSpace: 'pre-line' }}>{POSTAL_ADDRESS}</p>
                </div>
              ) : null}

              {PHONE ? (
                <div className="detail">
                  <h3>Phone</h3>
                  <p>
                    <a href={`tel:${PHONE.replace(/\s/g, '')}`} className="inline-link">
                      {PHONE}
                    </a>
                  </p>
                </div>
              ) : null}

              <div className="detail">
                <h3>Security reports</h3>
                <p>
                  <a href={`mailto:${CONTACT_EMAIL}?subject=Security`} className="inline-link">
                    {CONTACT_EMAIL}
                  </a>{' '}
                  — please put &ldquo;Security&rdquo; in the subject.
                </p>
                <p className="detail-note">
                  We will not take legal action against anyone reporting a vulnerability in good
                  faith. The code is public:{' '}
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-link">
                    read it here
                  </a>
                  .
                </p>
              </div>

              <div className="detail detail-warn">
                <h3>We will never ask for these</h3>
                <p>
                  Your PIN, your recovery phrase, or a screen share of your wallet. Nobody at Prova
                  needs them, and anyone who asks is not us — however convincing they sound.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
