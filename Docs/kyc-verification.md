# Prova — KYC & Verification

> Companion to [proposal.md](proposal.md) (§3 step 2, §4.2) and [implementation-guide.md](implementation-guide.md)
> (Phase 3 / Phase 5). This is the authoritative spec for how a Prova user is verified, how a
> verification is **approved**, and how the anchor-signed credential is issued, renewed and expired.
> **Read this before touching any KYC code.**

---

## 0. Decisions (frozen)

1. **Prova never performs KYC and never stores identity.** Verifying identity for cross-border money
   transfer is a licensed activity. The **anchor** decides; a **vendor** checks; Prova only routes and
   records an opaque status. See §2.
2. **Prova's backend is PII-free by construction** — not by policy. No name, DOB, document number or
   image is ever sent to, or stored by, Prova. The API is designed so it *cannot* be. See §3.
3. **Approval is a three-way decision** — auto-approve / auto-reject / manual review — driven by a
   decision engine over vendor signals, with a human compliance officer for the middle band. See §5.
4. **Credential issuance is gated by a persisted approval record**, never by the caller's request.
5. **Credentials are short-lived (90 days) and auto-renewed.** This is the revocation mechanism —
   see §7, which explains why an on-phone credential cannot be revoked directly.
6. **Stage A ships the machinery, not a vendor.** A `Provider` interface with a mock implementation;
   swapping in a real vendor (or the anchor's SEP-12 flow) is a driver change, not a rewrite.

Non-goals for Stage A: beneficiary/recipient verification (Stage B), Travel Rule IVMS101 exchange
(Phase 5), and cryptographic per-tier limits (§9 — needs a circuit change).

---

## 1. What "verification" means in Prova

Three distinct layers. Two already exist and work; this document is about the third.

| Layer | Where | Status |
|---|---|---|
| Per-transfer compliance proof (range + credential + nullifier) | Groth16 circuit → Soroban | ✅ Phase 3 |
| Anchor signature over the credential, verified **in-circuit** | `circuits/prover` | ✅ Phase 3 |
| **The real-world identity check that makes the credential mean anything** | this document | ⬅ Stage A |

---

## 2. Roles — who controls the decision

```
  USER               VENDOR                 ANCHOR (licensed)          PROVA
  (phone)            (Sumsub/Onfido…)                                  (backend)
  ────────           ───────────────        ─────────────────          ─────────
  captures ID   →    checks:           →    DECIDES approve/reject →   records status
  + selfie           • document genuine     SIGNS the credential       ISSUES credential
                     • face match           STORES the identity        (gated on approval)
  holds the          • liveness
  credential         • sanctions/PEP        ── legally responsible ──  never sees identity
                     returns a verdict
```

- The **vendor** checks and reports. It does not decide.
- The **anchor** (CBUAE-licensed exchange house for the UAE→IN corridor) decides, signs, and is the
  legal custodian of the identity data.
- **Prova** routes the user to the check and relays the signed credential.

**Today (Stage A):** no anchor exists yet, so the Prova backend *plays* the anchor — it already holds
the anchor signing key from Phase 3. This is a simulation. The `Provider` interface (§8) is the seam
along which that responsibility moves to a real anchor in Phase 5 without a rewrite.

---

## 3. Data collected, and the privacy boundary

### Tiers

Data is tied to limits — collect the minimum for what the user needs.

| Tier | Level | Data collected | Purpose |
|---|:--:|---|---|
| **Basic** | 1 | Phone (already held), full name, date of birth, nationality | Identify + screen against sanctions lists |
| **Standard** | 2 | + government ID (Emirates ID / passport: images, number, expiry) + **liveness selfie** | Prove the identity is real and belongs to this person |
| **Enhanced** | 3 | + proof of address, occupation / source of funds | Enhanced due diligence for higher value |

Most users need only **Tier 2**. Limits per tier: §9.

### Where each piece lives — the boundary that must never move

| Data | Stored by | Prova sees it? |
|---|---|---|
| Name, DOB, nationality | Vendor / anchor | ❌ never |
| ID document images, selfie, document number | Vendor / anchor | ❌ never |
| `userId` = `Poseidon(secret, domain)` | Prova DB | ✅ opaque — reveals nothing |
| Verification **status**, **tier**, **expiry**, provider reference | Prova DB | ✅ |
| Signed credential | User's phone (secure enclave) | ✅ in transit only |

**The complete Prova record for a user is:**

```
userId (opaque) · status · tier · expiry · providerRef · reasonCode · timestamps
```

### How PII avoids the backend — by construction

The client **never sends PII or images to Prova**. Documents go straight to the vendor (their SDK
uploads directly). Prova's submit endpoint accepts only the opaque `userId` and the requested tier;
the verdict arrives later on a webhook. There is no endpoint that *can* accept a document, so there
is no document store to leak — and no licence needed to hold one.

In Stage A (mock provider, no vendor) the captured images **never leave the device and are never
persisted**; the app submits only "documents captured" as a boolean set.

---

## 4. States

```
                    ┌──────────────┐
                    │ not_started  │
                    └──────┬───────┘
                           │ submit
                           ▼
                    ┌──────────────┐   provider verdict
                    │   pending    │────────────┬──────────────┐
                    └──────┬───────┘            │              │
                           │ borderline         │ clear        │ hard fail
                           ▼                    ▼              ▼
                    ┌──────────────┐     ┌────────────┐  ┌────────────┐
                    │  in_review   │────▶│  approved  │  │  rejected  │
                    │  (human)     │     └─────┬──────┘  └─────┬──────┘
                    └──────┬───────┘           │               │ resubmit
                           │ reject            │ 90 days       ▼
                           └──────────────▶    ▼          (back to pending)
                                          ┌────────────┐
                                          │  expired   │──▶ renew ──▶ pending
                                          └────────────┘
```

| State | Meaning | Can transfer? |
|---|---|:--:|
| `not_started` | No verification attempted | ❌ |
| `pending` | Submitted, automated checks running | ❌ |
| `in_review` | Escalated to a human compliance officer | ❌ |
| `approved` | Verified; credential issuable | ✅ |
| `rejected` | Failed; may resubmit if the reason allows | ❌ |
| `expired` | Credential lapsed; renewal required | ❌ |

Rules:
- Transitions are **one-way per submission**; a new attempt creates a new submission (the audit
  trail keeps every one).
- `rejected` carries a machine-readable `reasonCode` so the app can explain what to fix.
- Terminal-for-fraud reasons (confirmed sanctions match) **must not** be resubmittable.

---

## 5. How approval actually happens

### Signals (from the vendor)

| Check | Catches |
|---|---|
| NFC chip read (Emirates ID / e-passport) | Forged documents — the chip is signed by the issuing state |
| Document forensics (MRZ checksum, security features, tamper) | Photoshopped documents |
| Face match (selfie ↔ document portrait) | Using someone else's ID |
| Liveness / anti-spoofing | Photo-of-photo, screen replay, masks, deepfakes |
| Data cross-check (OCR vs MRZ vs chip) | Altered fields |
| AML screening (sanctions, PEP, adverse media) | Prohibited or high-risk persons |
| Dedupe / velocity (same face or document already registered) | One person farming many accounts |

### Decision rules

| Outcome | Condition |
|---|---|
| **auto-approve** | Document genuine, face match ≥ threshold, liveness passed, **zero** sanctions/PEP hits, not a duplicate |
| **auto-reject** | Tampered/forged document, expired ID, failed liveness, **confirmed** sanctions match, underage |
| **manual review** | Borderline face-match score, poor capture quality, **fuzzy** watchlist name match, field mismatch, duplicate-face signal |

The middle band is not optional: common names produce constant fuzzy watchlist matches, and only a
licensed compliance officer may clear them. In production that officer belongs to the **anchor**.

### The issuance path

1. Provider finishes → posts a verdict to the **webhook** (async: seconds to hours).
2. Backend writes the **approval record** + an **immutable audit entry** (verdict, tier, reason,
   reviewer, timestamp). Regulators require proof of *why* each decision was made.
3. **Only if the stored record is `approved`** will the backend sign a credential.
4. The app polls status, then requests the credential and stores it in the enclave.

Webhooks are **authenticated** (shared-secret HMAC signature) and **idempotent** (replaying a verdict
must not duplicate records or re-issue).

---

## 6. API

| Endpoint | Purpose |
|---|---|
| `POST /kyc/verifications` | Start a verification. Body: `{ userId, tier, captured }` — **no PII**. Returns `{ verificationId, status }` |
| `GET /kyc/verifications/{userId}` | Current status: `{ status, tier, expiry, reasonCode, updatedAt }` |
| `POST /kyc/verifications/webhook` | Provider verdict (HMAC-authenticated, idempotent) |
| `POST /kyc/credential` | Issue the signed credential — **gated**: 403 unless an `approved` record exists for `userId` |
| `POST /kyc/verifications/{id}/decide` | **Dev/compliance only** — manual approve/reject for the review queue |

---

## 7. Credential lifecycle — and why expiry *is* the revocation mechanism

The credential lives in the user's **phone**, and the circuit only enforces `expiry >= currentTime`.
There is no way to reach into a device and revoke it, and no revocation list in the circuit.

**Therefore: short-lived credentials.**

- **Expiry: 90 days** (was 365 — a sanctioned user could have transacted for a year).
- **Auto-renewal**: the app silently requests a fresh credential when < 14 days remain.
- **Re-screening on every renewal**: the provider re-runs sanctions/PEP. A new hit stops the renewal,
  and the credential dies on its own **within 90 days** — a bounded exposure window.
- A `revoked` verification record blocks all future issuance immediately (it only cannot retract the
  credential already on the device — hence the short window).

This is the standard trade-off for offline-verifiable credentials, and it is why the expiry window is
a **security parameter**, not a convenience setting.

---

## 8. Provider interface

```go
type Provider interface {
    // Start a verification; returns the provider's reference. No PII crosses this boundary.
    Start(ctx, userID string, tier int) (providerRef string, err error)
    // Verdict maps a provider payload onto our decision (used by the webhook).
    Parse(payload []byte) (Verdict, error)
}

type Verdict struct {
    ProviderRef string
    Decision    string // "approved" | "rejected" | "review"
    Tier        int
    ReasonCode  string
}
```

- **Stage A — `mock`**: simulates the pipeline (configurable auto-approve delay, plus deterministic
  hooks to force `review`/`rejected` so every path is testable).
- **Stage C — vendor**: Sumsub / Onfido / Persona sandbox → real document, liveness and AML checks.
- **Phase 5 — anchor**: the licensed anchor's own flow via SEP-12; their compliance team decides.

---

## 9. Tier limits — and an honest limitation

| Tier | Level | Per-transfer limit |
|---|:--:|---|
| Basic | 1 | 1,000 |
| Standard | 2 | 9,999 (circuit maximum) |
| Enhanced | 3 | 9,999 today — a higher cap needs a circuit change |

⚠️ **Per-tier limits are currently enforced in the app and backend policy, *not* in the circuit.**
The circuit enforces exactly two things: `kyc_level >= MIN_KYC_LEVEL` and `amount <= MAX_AMOUNT`
(a single global 9,999). A modified client could therefore send up to the global cap regardless of
its tier.

Closing this properly requires **circuit v3** — making the limit a function of `kyc_level` — which
means a new trusted setup, a new verification key, and a contract redeploy. That is deliberately out
of Stage A scope, but it must be done before real money moves. Until then, tiering is a **product**
control, not a cryptographic one, and this document should be the place that says so plainly.

---

## 10. Security properties

- Prova **cannot** leak identity data it never receives (§3) — a design property, not a promise.
- Credential issuance is **impossible** without a stored `approved` record (§5), closing the current
  "anyone who calls the endpoint gets a credential" hole.
- Webhooks are authenticated and idempotent; replay cannot forge an approval.
- Every decision is written to an **append-only audit log** (who/what/when/why).
- Sanctions exposure is bounded by the **90-day** credential window (§7).
- `userId` is `Poseidon(secret, domain)` — it identifies a wallet to the anchor without revealing the
  wallet secret, and cannot be linked to on-chain commitments.

---

## 11. Build status

| Stage | Scope | Status |
|---|---|---|
| **A** | State machine, capture UI, gated issuance, lifecycle/renewal, tiers | ⬅ in progress |
| **B** | Beneficiary (recipient) verification — the other half of cross-border | planned |
| **C** | Real vendor sandbox behind the `Provider` interface | planned |
| **D** | Phase 5: licensed anchors, SEP-12, Travel Rule, regulator sign-off | planned |
