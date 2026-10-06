/**
 * Privacy Policy and Terms of Service.
 *
 * Lives in the shared package, not in either client, so the app and the marketing site render the
 * *same* wording from one definition. Two copies of a policy drift, and a policy that says different
 * things in different places is worse than having none.
 *
 * The text below describes what this build actually does — it is not boilerplate. Where something
 * is not yet true (a licensed anchor, a live corridor), it says so plainly rather than implying a
 * service that does not exist yet. Have a lawyer review this before taking real customers: the
 * technical claims are accurate, but jurisdiction, liability and dispute wording are not the sort
 * of thing an engineer should be writing unreviewed.
 */

export type LegalDocId = "privacy" | "terms";

export interface LegalSection {
  heading: string;
  body: string[];
}

export interface LegalDoc {
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
  contact: string;
}

const UPDATED = "6 October 2026";
const CONTACT =
  "Questions about this document? Use “Chat with us” in your profile, or email prova.payment@gmail.com, and a member of the team will reply — usually within 24 hours.";

export const LEGAL_DOCS: Record<LegalDocId, LegalDoc> = {
  privacy: {
    title: "Privacy Policy",
    updated: UPDATED,
    intro:
      "Prova is a testnet app. This policy describes what stays on your phone, what our services hold, and the limits of the current identity demo.",
    sections: [
      {
        heading: "What never leaves your phone",
        body: [
          "Your recovery seed, your spending keys and your PIN are generated on your device and stored in its secure hardware. We never receive them, and nobody at Prova can recover them for you.",
          "Transfer amounts are never sent to us. Your device produces a zero-knowledge proof that a transfer is valid, and only that proof — plus values that reveal nothing on their own — is published.",
          "The current test credential flow does not request identity documents or selfies. Older app builds captured photos locally but did not transmit them to Prova or a reviewer.",
        ],
      },
      {
        heading: "What we do hold",
        body: [
          "Your email address, which identifies your account and is where sign-in codes are sent.",
          "A pseudonymous identifier derived from a key on your device. It is not reversible into your name or your identity.",
          "The status of your test credential request, when it changed, and which operator decided it. This is a demo approval record, not proof of a licensed identity check.",
          "Records of transfers limited to the values published on the public blockchain, together with timestamps and status. These contain no amounts and no names.",
          "Support conversations you start with us, so the team can answer you and refer back to what was said.",
        ],
      },
      {
        heading: "Test credential approval",
        body: [
          "The current backend uses a mock verification provider. An operator may approve a test credential, but no licensed provider checks an ID document in this build. Approval timing is not guaranteed.",
          "The resulting credential is stored on your device and is used by the Stellar testnet proof. Midnight credential proving is being integrated and does not yet authorize an app transfer.",
        ],
      },
      {
        heading: "Other parties",
        body: [
          "Stellar is a public blockchain. Commitments, nullifiers and proofs written there are permanent and visible to anyone. They do not reveal amounts, names, or who paid whom.",
          "A future real-money corridor would require licensed financial partners and their own checks. This build uses test networks and test assets with no monetary value.",
          "Cloud backup, if you turn it on, stores an encrypted file in your own iCloud or Google Drive. It is encrypted with a key derived from your PIN before it leaves the device, so the storage provider cannot read it — and neither can we.",
        ],
      },
      {
        heading: "Your choices",
        body: [
          "You may stop using the app at any time and delete it; the keys on your device go with it. Because we do not hold your keys, we cannot restore an account without your backup and PIN.",
          "You may ask us what we hold about your account and ask us to delete it. Some verification records must be retained where the law requires it, and anything already written to the blockchain cannot be removed by anyone.",
        ],
      },
    ],
    contact: CONTACT,
  },

  terms: {
    title: "Terms of Service",
    updated: UPDATED,
    intro:
      "These terms cover your use of the Prova app. Please read the section on test networks — it is the most important one right now.",
    sections: [
      {
        heading: "This is a test build",
        body: [
          "Prova currently operates on the Stellar test network using test assets. Those assets have no monetary value and cannot be exchanged for money. Nothing you do in this build moves real funds.",
          "Test networks can be reset, and balances may disappear without notice. Do not treat anything held here as savings.",
        ],
      },
      {
        heading: "Your account and your keys",
        body: [
          "Your account is secured by keys held only on your device, protected by your PIN and your device biometrics. You are responsible for keeping these safe.",
          "If you lose your device without a backup, or forget your PIN, we cannot recover your account. This is a direct consequence of us never holding your keys, and it is not a limitation we can waive for individual users.",
        ],
      },
      {
        heading: "Verification and eligibility",
        body: [
          "The current app requires a test credential before sending. Its demo approval process is not a licensed identity verification.",
          "We may decline a test credential request or refuse to relay a transfer. We cannot reverse a transfer after it is confirmed on-chain.",
          "Transfer limits apply according to your verification tier and are enforced both in the app and on the network.",
        ],
      },
      {
        heading: "Acceptable use",
        body: [
          "Do not use Prova for anything unlawful, to evade sanctions or tax, to launder money, or on behalf of somebody else without telling us.",
          "Do not attempt to interfere with the service, the smart contracts, or other users, and do not use automated means to create accounts.",
        ],
      },
      {
        heading: "Availability and liability",
        body: [
          "The service is provided as-is while in testing. We do not guarantee it will be available, uninterrupted, or free of defects, and features may change or be withdrawn.",
          "Transactions confirmed on a public blockchain are final and cannot be reversed by us.",
          "To the extent the law allows, we are not liable for loss arising from your use of a test build, including loss of test assets or of access to your account.",
        ],
      },
      {
        heading: "Changes",
        body: [
          "We may update these terms as the service develops, particularly when moving from a test network to live operation. Continuing to use the app after a change means you accept the updated terms.",
        ],
      },
    ],
    contact: CONTACT,
  },
};
