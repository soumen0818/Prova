import type { Metadata } from 'next';

import { GetAppButton } from '@/components/get-app-button';
import { SiteFooter, SiteHeader } from '@/components/site-chrome';

import '../marketing.css';

/**
 * Where a pay link lands when Prova is *not* installed.
 *
 * With the app installed Android verifies the domain against `/.well-known/assetlinks.json` and
 * opens the app directly — this page is never rendered. So its only job is the other case: someone
 * was sent money-receiving details by a friend and has no way to use them yet.
 *
 * The address is in the URL fragment, which browsers never send to a server. This page is therefore
 * static and personalises nothing: it cannot see whose address it is, and that is deliberate — the
 * fragment is what keeps a shared link from becoming a lookup directory we would have to be trusted
 * with.
 */
export const metadata: Metadata = {
  title: 'Add a recipient · Prova',
  description: 'Open this link on a phone with Prova installed to add a recipient.',
  // A pay link is personal and disposable; it has no business in a search index.
  robots: { index: false, follow: false },
};

export default function PayPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="section">
          <div className="page">
            <div className="cta reveal in">
              <span className="eyebrow">Payment link</span>
              <h2>Install Prova to use this link</h2>
              <p>
                Someone shared their Prova details with you. Install the app, then open their link
                again — it will fill in their address for you.
              </p>

              <GetAppButton className="btn btn-primary" />

              <p className="cta-note">
                Already have Prova? Open the link from the same phone and it will go straight to the
                app. If it opened here instead, the app may need to be updated.
              </p>

              <div className="steps-inline">
                <h3 className="steps-inline-title">What happens after you install</h3>
                <ol className="steps-inline-list">
                  <li>
                    <b>Open their link again</b> — the app opens with their address already filled
                    in.
                  </li>
                  <li>
                    <b>Give them a name</b> so you recognise them later. It stays on your phone.
                  </li>
                  <li>
                    <b>Send.</b> You will need to verify your identity first, which takes a few
                    minutes.
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
