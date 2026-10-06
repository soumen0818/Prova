# Prova Wave 2 — audit and delivery plan

_Audit started 2026-10-06. This is a working checklist, not a claim that the combined flow already works._

## Outcome for this wave

Show one honest, reproducible testnet journey: a user receives an **operator-approved demo credential**, proves eligibility on Midnight Preprod, and Prova's **backend relay** submits the corresponding Stellar transfer only after checking a matching, unconsumed Midnight decision. The Android app and public website must show the same status and privacy boundary as the code. A reviewer should be able to repeat the demo from the README, verify both network references, and see automated tests and CI.

**Architecture decision (owner approved):** for this challenge demo, the Go backend may act as a trusted verifier on Prova's app/relay path. This is **not protocol-wide enforcement**. `contracts/pool/src/lib.rs` exposes a permissionless `transact`, so someone with a valid Stellar spend proof can bypass the backend and call Soroban directly. The long-term product should move the authorization check into the settlement contract or a rigorously verified on-chain attestation/bridge. Do not call the relay gate atomic or censorship-resistant.

Do **not** call the current Stellar-only app, an isolated Midnight contract call, or a manually approved record the combined journey.

## Evidence from the repository

| Area | Present | Gap / risk | Gate |
| --- | --- | --- | --- |
| Stellar payments | Android app, Go API, Soroban pool and verifier, testnet transaction evidence | Existing app does not ask for or display a Midnight decision | Preserve existing send semantics and no-double-send recovery |
| Midnight privacy | Compact compliance contract, 39 previously passing tests, CI, initial Preprod deployment | No app credential issuance/proof call; no managed replacement receipt; initial address lacks retained maintenance key | Managed address and public readback; real proof from the user flow |
| Cross-network handoff | `backend/internal/provider/intent.go` models an advisory decision | `pool_handlers.go` settles without checking Midnight; the permissionless Soroban contract can be called directly | Define verification, binding, replay, timeout, and failure policy for the **relay path**; document direct-call bypass |
| Identity review | Mobile previously captured ID/selfie locally; Go uses `MockProvider`; manual queue available | Photos never reach reviewer/vendor. Manual approval therefore is **not evidence of identity verification**. `Service.Renew` extends a credential without a fresh provider/operator check | Label and constrain demo mode; require a new review for real credential renewal |
| Mobile UX | Onboarding, KYC, send confirmation, processing/result, activity, backup | Copy does not mention Midnight, hides the simulated KYC limit, and cannot display proof/settlement states across both chains | Test first-time, declined, delayed, replay, and interrupted journeys on Android |
| Website | Next.js marketing site and operations console | Public site only describes Stellar and overstates document review; no current Midnight status/evidence page | Explain both roles and the current limit without implying the integration is live |
| Documentation | Detailed README and architecture; proof screenshots | Several documents still describe aspirational behavior as shipped; deployed address is explicitly superseded | One canonical status and submission evidence set |

### Provisional product review (source and screenshots only)

These scores are **not** a physical-device usability test. They prioritize work and must be replaced by a fresh-install walkthrough before release.

| Dimension | Score | Evidence / next check |
| --- | ---: | --- |
| Onboarding | 4/10 | Email/PIN path exists, but the older APK requests ID photos without an actual document check. Test the revised flow on-device. |
| Core transfer | 6/10 | Stellar pool send, receipt, and activity code exist; Midnight is absent from the app journey. Repeat with two devices. |
| Error handling | 7/10 | Send distinguishes definite failure from ambiguous submission and warns against duplicate payment; cross-chain failure states do not exist yet. |
| Information architecture | 7/10 | Home, send, activity, profile, and support are findable; no visible status for a Midnight decision. |
| Visual polish | 7/10 | Shared dark/chartreuse tokens and product screenshots exist; changes still need a device review. |
| Performance | 5/10 | Local proof benchmarks exist; no full Preprod-to-Stellar timing or low-end Android measurement. |
| Accessibility | 5/10 | Native controls and labels exist, but screen-reader, font-scaling, focus, and contrast tests were not run. |
| Feature completeness | 4/10 | Testnet transfers work; managed Preprod deployment, enforced handoff, and release evidence are missing. |

Strengths: a real Stellar testnet payment path, explicit payment uncertainty handling, and adversarial Midnight contract tests. Highest-impact gaps: simulated identity presented as real review, no enforced Midnight-to-Stellar join, and public artifacts that still describe the older app.

## Prioritized code work

### P0 — prevent misleading claims and unsafe demo behavior

- [x] Start correcting app, website, shared privacy/legal, README, and operator copy: the new app path requests a demo credential without ID/selfie capture. **Still open:** repository-wide copy audit, release APK, and deployment of the updated site/API.
- [x] Label demo mode in API responses and force the mock provider into operator review even if the old `KYC_MANUAL_REVIEW=false` flag is set. This remains a testnet-only credential; real-money use is out of scope.
- [ ] Finish reviewing the approval endpoint, operator permissions, and audit log for ways an unchecked identity could receive a credential. Renewal is disabled and has a regression test; other abuse paths still need tests.
- [x] Disable automatic renewal: the old `Service.Renew` reissued without a provider/operator check. The API now requires a new reviewed test-credential request; the app no longer silently renews. Verify the expired-state journey on a physical device.
- [ ] Keep the Stellar send path working while changes land; no ambiguous failure may encourage the user to pay twice.

### P1 — prove and enforce the Midnight decision

- [ ] Re-establish the pinned Compact/Node toolchain and rerun the full Midnight suite. The current host reports Compact `0.34.0`; the project pins `0.31.1`. Record exact command, version, and result.
- [ ] Finish managed Preprod deployment using a retained maintenance key. Verify constructor state and save the canonical address, transaction hash, and public verification output. Do not reuse the superseded address.
- [ ] Define the **exact common identifier** joining the Midnight decision to the Stellar spend (domain, encoding, network IDs, nullifier, expiry). Test mismatched and replayed identifiers.
- [ ] Add a narrow proof/decision service with authenticated or locally controlled proving. The private credential and witness must not be sent to an untrusted hosted proof server.
- [ ] Make the **backend relay path** fail closed when a required Midnight decision is absent, invalid, stale, already consumed, or from the wrong network/contract. Retain an explicit demo-only legacy path if needed; do not silently fall back. A direct Soroban call remains possible until the contract changes.
- [ ] Reconcile both chains after ambiguous timeouts. Persist state transitions and idempotency keys, then test crash/retry/replay and partial success cases. Cross-chain settlement is not atomic: document the remaining trust boundary.

### P2 — app and website reflect the implementation

- [ ] Add user-visible stages: credential ready → Midnight proof pending/confirmed → Stellar transfer pending/confirmed, with network-specific references and recovery actions.
- [ ] Show the testnet/demo identity status honestly; do not imply a licensed KYC provider or a completed corridor.
- [ ] Add a clear, concise Midnight + Stellar architecture/status section to the public website. Link the verified Preprod contract, Stellar contracts, source, tests, and known limits.
- [ ] Audit marketing, About, How it works, FAQ, privacy/legal, and app onboarding for inconsistent promises (documents, amounts, time, fees, anonymity, settlement).
- [ ] Verify loading, empty, error, accessibility, small-screen, and reduced-motion states in the app and website. Preserve the existing Prova visual system in `Docs/design-system.md`.

### P3 — evidence and release

- [ ] Run Go, Rust/circuit, shared, mobile, web, and Midnight test/build checks; review all affected CI workflows and green runs.
- [ ] Build a new Android APK containing the actual Wave 2 flow. Do not reuse the older APK as evidence of Midnight integration.
- [ ] Perform a fresh-device, two-user end-to-end test on Preprod + Stellar testnet; record exact contract addresses and transaction references.
- [ ] Update README setup/usage, privacy model, architecture, troubleshooting, deployment status, and submission links from verified output.
- [ ] Record a one-minute video of the **combined** flow, plus genuine screenshots of tests and passing CI.

## Manual / external work needed from the owner

- Supply or choose a legitimate KYC sandbox/provider and, for any real-money corridor, licensed partners. A reviewer cannot validate unseen ID photos in the present flow.
- Keep Midnight deployer seed, issuer secret, policy secret, and maintenance key backed up privately; fund the deployer with Preprod test assets if a replacement transaction is needed. Never put secrets in the repo or a form.
- Test the release APK on a physical Android device, preferably two devices/users; capture the combined journey and failure states.
- Create or provide the product X profile and organizer idea-approval evidence, if required by the challenge; publish the demo video and final links.
- Approve any real service, account, or domain changes before deployment. Code changes alone do not update the already-hosted APK/site.

## Checks performed in this audit

- `go test ./...` in `backend/`: passed locally.
- `npm run typecheck` in `mobile/` and `web/`: passed locally.
- `npm test` in `privacy/midnight/`: **not a circuit verdict**; stopped at toolchain check because installed Compact is `0.34.0`, not pinned `0.31.1` (the sandbox also reported `spawnSync compact EPERM`). Prior recorded evidence shows 39 passing tests with the pinned toolchain.
- Mobile lint, typecheck, and format: passed after the main copy edits; rerun if later mobile code changes.
- Web production build and format: passed after the main copy edits; rerun if later web code changes.
- Go test suite: passed after the mock-provider guard, using a writable task-specific Go build cache.
- Shared package tests: 2 passed; mobile typecheck/lint/format passed; web production build and format passed after the final source edits. These local results are not a fresh public CI run.

## Wave 2 exit criteria

1. Fresh clone builds and tests green with documented tool versions.
2. A fresh Android install shows an honest identity status and completes a Midnight proof plus a Stellar test transfer.
3. Prova's **backend relay** cannot submit through the new app path without a matching, unconsumed Midnight authorization; every failure path is tested and recoverable. The README explicitly says that direct permissionless Soroban calls bypass this demo gate.
4. README and website link the **canonical** Preprod address, Stellar contracts, and a real combined-flow demonstration; no older APK/video is mislabeled.
5. Manual KYC/licensing limits and cross-chain trust boundary are explicit to reviewers.

## Audit limitations

This is a source-and-local-check audit, not a physical-device usability test, independent cryptographic audit, production service penetration test, or verification of current external URLs. Those gates remain open. The work above should be completed in order; especially do not wire a payment gate to an unverified deployment or label simulated identity checks as real compliance.
