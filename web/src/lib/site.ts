/**
 * Facts about Prova that appear in more than one place on the site.
 *
 * Contact details in particular: an email address that is right on the contact page and stale in
 * the footer is worse than one that is missing, because somebody will write to the dead one and
 * conclude nobody is home. One definition, imported everywhere.
 */

/** Where anything addressed to Prova should go. */
export const CONTACT_EMAIL = 'prova.payment@gmail.com';

/** What we tell people about how quickly they will hear back. Matches the in-app promise. */
export const RESPONSE_TIME = 'within 24 hours';

/**
 * Postal address and phone.
 *
 * Deliberately empty rather than invented. The contact page renders these only when they are set,
 * so filling them in here is all that is needed — and until Prova is a registered entity with a
 * real address, publishing one would be a lie on the page a regulator reads first.
 */
export const POSTAL_ADDRESS: string = '';
export const PHONE: string = '';

/** The corridor this build is aimed at, stated the way the product describes it. */
export const CORRIDOR = 'United Arab Emirates → India';

/** Where the code lives. Public, and the strongest claim the site can make about the privacy story. */
export const REPO_URL = 'https://github.com/soumen0818/Prova';

/**
 * Direct download for the Android build.
 *
 * Empty until there is an APK to serve — drop the file at `public/prova.apk` and set this to
 * `/prova.apk`, or paste a hosted URL. The download section reads this and switches itself from
 * "not ready yet" to a real button, so shipping the build is a one-line change here and nothing
 * else. An empty string is deliberate: a download button that 404s is worse than one that is
 * honestly absent.
 */
export const APK_URL: string =
  'https://expo.dev/artifacts/eas/oAnuYNhjY-gr636BxvyngC_PMGn6MzBFHKH9Uok5k88.apk';

/**
 * Shown next to the download so people know what they are installing.
 *
 * The size is here because this is a sideloaded APK on a link people may open over mobile data, and
 * arm64 because that is what the build ships: the ZK prover has no 32-bit binary, so an older device
 * would install and then fail at the moment it tried to send. Saying so beats a silent failure.
 */
export const APK_VERSION = '1.2.5 · Android (arm64) · testnet · 86 MB';
