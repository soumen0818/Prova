import { APK_URL, APK_VERSION, CONTACT_EMAIL } from '@/lib/site';

/**
 * The download section.
 *
 * Replaces an earlier "Request the test build" button, which asked people to email for access to
 * something they had no way to evaluate — an odd first step for a product whose whole pitch is that
 * you should not have to trust it. This says plainly what the app is, what state it is in, and
 * gives a direct download the moment there is one to give.
 *
 * Until `APK_URL` is set the button is replaced by an honest "not yet" and a way to be told when it
 * lands. A dead download link would be worse than no link at all.
 */
export function GetTheApp() {
  const ready = APK_URL !== '';

  return (
    <section className="section" id="get-the-app">
      <div className="page">
        <div className="cta reveal">
          <span className="eyebrow">Get the app</span>
          <h2>Try Prova on Android</h2>
          <p>
            Prova is an Android app. It runs on the Stellar test network, so balances are test
            assets with no monetary value and the network can be reset at any time — try it freely,
            but do not treat what is in it as savings.
          </p>

          {ready ? (
            <>
              <a className="btn btn-primary" href={APK_URL} download>
                Download for Android
              </a>
              <p className="cta-note">{APK_VERSION}</p>
            </>
          ) : (
            <>
              <div className="cta-pending">
                <span className="pulse-dot" />
                The download is not up yet — we are finishing the first public build.
              </div>
              <a
                className="btn btn-ghost"
                href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Tell me when the Prova app is ready')}`}>
                Email me when it is ready
              </a>
            </>
          )}

          <p className="cta-note">
            You will need to allow installing from outside the Play Store. Prova is not on the Play
            Store yet — a payments app has to clear their financial-services review first, and we
            would rather ship it there properly than not at all.
          </p>
        </div>
      </div>
    </section>
  );
}
