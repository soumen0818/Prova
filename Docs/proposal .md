# Prova — Private, Compliant Cross-Border Remittance on Stellar

> **Name:** *Prova* — from "proof." The product turns a **proof** into the thing that moves money:
> a transfer is accepted because it can be *proven* legal, not because anyone saw the details. The
> guiding metaphor stays the sealed letter with a notary stamp — the post office never opens the
> letter, it just trusts the stamp. Here the stamp is a ZK proof, and Prova is the stamp.

**One-liner:**
*Make sending money home feel like sending a WhatsApp message — fast, cheap, and nobody in the
middle can read it — while the regulator stays mathematically certain the transfer is legal.*

**Audience for this doc:** technical reviewers and evaluators. Architecture, ZK mechanics, and the
Stellar integration are front and center.


## 0. TL;DR (read this first)

| | |
|---|---|
| **Who** | Migrant workers sending remittances home. Persona: *Ravi* in Dubai → *Amma* in West Bengal. |
| **Pain today** | 5 intermediaries see his exact amount, 5–7% fees, 2–5 day delays, zero privacy. |
| **The real hard problem** | **Privacy and compliance are opposites.** Every payment system must *see* your data to *verify* it's legal. |
| **The breakthrough** | A **zero-knowledge "compliance certificate"** proves a transfer is legal *without revealing the amount or identity*. |
| **Why Stellar** | Stellar already solved speed, cost, and fiat access (anchors + SEPs). Soroban supports BN254. We add the **one missing layer: privacy in transit.** |
| **Why now** | Each primitive — ZK proofs, Stellar's anchor network, Soroban's BN254 verification — is independently mature. Prova is the first design to **compose** them into one private, compliant corridor. |
| **Why it's defensible** | The ZK math is open source. The moat is anchor partnerships + a public trusted-setup ceremony + regulatory precedent + user trust. |

---

## 1. The Problem

### 1.1 The story (why this is real, not abstract)

Ravi works in Dubai. His mother lives in a small town in West Bengal. Every month he sends her
₹15,000 — for groceries, medicine, the electricity bill. Millions of people do exactly this.

Here is what happens to that ₹15,000 **today**:

```
Ravi → UAE bank/exchange → SWIFT correspondent bank → forex desk → Indian bank → Amma
         (sees amount)        (sees amount)            (sees amount) (sees amount)
```

**Five different companies can read his exact amount.** He loses 5–7% in fees. It takes 2–5 days.
And there is nothing he can do about it — that is simply how the system works.

### 1.2 The structural problem

This is not a UX inconvenience. It is structural:

- **No privacy.** Your salary, your family's monthly budget, your spending patterns — all visible
  to every intermediary, and sellable as data.
- **Cost.** Every intermediary takes a cut. The $800B/year global remittance market loses tens of
  billions to the middle.
- **Latency.** Correspondent banking settles in days, not seconds.

Crypto "solved" cost and speed years ago. So why hasn't this been fixed for Ravi? Because of the
**deeper** problem below.

### 1.3 The *real* hard problem (the one that matters)

> **Privacy and compliance are mathematical opposites — and nobody has solved making them work
> together on a live payment corridor at consumer scale.**

Every existing payment system works like a **transparent pipe**: every node sees everything,
*because seeing is how it verifies*.

- To check "does Ravi have enough money?" → the system **reads his balance**.
- To check "is this amount within the legal limit?" → the system **reads the amount**.
- To check "is this person KYC'd and not sanctioned?" → the system **reads his identity**.

**You cannot verify something you cannot see.** That single constraint is what makes privacy and
compliance enemies in every system that exists today. Banks need your data to approve a transfer;
regulators need your data to bless it. Privacy is the thing both of them have to break.

This is why every previous attempt failed (see §10): each one picked *one* of {privacy, compliance,
fiat access} and sacrificed the other two.

---

## 2. The Solution

### 2.1 In one paragraph

The amount stays **private** while it travels, but a **mathematical proof travels alongside it** that
says *"trust me, this is legitimate"* — and anyone can verify that proof **without ever learning the
actual number.** That is what zero-knowledge means: you prove a statement is true without revealing
the secret behind it. Concretely: when Ravi sends ₹15,000, his phone generates a ~200-byte
**Groth16 proof** that simultaneously asserts (a) the amount is within the legal limit, (b) he holds
a valid KYC credential from a licensed anchor, and (c) this exact transfer has never been spent
before. A **Soroban smart contract on Stellar** verifies that proof in milliseconds and accepts or
rejects it. If accepted, only a **commitment hash** is written on-chain. The number ₹15,000 appears
*nowhere*.

### 2.2 The mental model

> A **sealed letter with a notary stamp.** The post office doesn't open the letter to know it's
> valid — it trusts the stamp. Here, **the notary is math**, it runs on Ravi's phone, and the stamp
> carries *zero* personal information.

And for how it relates to Stellar:

> ZK is to Stellar's payment rails what **HTTPS is to the internet.** The internet could already move
> data; HTTPS added a privacy/security layer *on top* without replacing the pipes. We add a privacy
> layer on top of Stellar's existing payment pipes — we don't replace them.

### 2.3 What makes "private + compliant" finally possible

Normally, privacy and compliance are enemies. **ZK proofs make them friends.** The regulator does
not actually need to *see* the amount — they need to *verify three facts*:

1. The sender is **KYC'd**.
2. The amount is **within legal limits**.
3. The money is **not from a sanctioned/criminal source**.

A ZK circuit proves all three are true and outputs only `valid / KYC'd / within-limits /
not-sanctioned` — never the underlying number. In most jurisdictions that is **legally sufficient**.
That is the entire innovation.

---

## 3. End-to-End User Workflow

What Ravi *sees* on screen vs. what happens *invisibly* behind it.

| # | Step | What Ravi sees | What happens behind the scenes |
|---|------|----------------|--------------------------------|
| 1 | **Sign up** | Phone number + biometric, like any wallet app. | A Stellar keypair is generated on-device. A separate **ZK secret key** is derived and stored in the phone's secure enclave — it never leaves the device. |
| 2 | **KYC (once)** | Photographs passport/Emirates ID. "You're verified ✅". | The **UAE anchor partner** runs full KYC + sanctions screening off-chain, then signs an **attested credential**: `sign(ravi_pubkey + kyc_level + expiry)`. This credential is stored *in Ravi's wallet only — never on-chain.* |
| 3 | **Deposit** | Adds AED via card/bank, sees AED balance. | The anchor mints/credits the value onto Stellar through standard **SEP deposit flow**. |
| 4 | **Enter amount** | Types ₹15,000, picks Amma as recipient. | The moment the "send" screen opens, the app **pre-computes the witness** in the background — half the proving work is done before he even hits confirm. |
| 5 | **Confirm → "Securing your transfer… 8s"** | A progress bar fills honestly. | **This is the hard part.** The phone generates the Groth16 proof: range check + KYC-credential check + nullifier — all in pure math, no server. Output: a ~200-byte certificate. |
| 6 | **Sent ✅** | "Delivered." | The proof + commitment go to the **Soroban contract**, which runs one **BN254 pairing check** in milliseconds, records the **nullifier** (anti-replay), and writes the **commitment hash** on-chain. |
| 7 | **Amma receives** | Gets ₹ in her bank / cash-out point. | The **Indian anchor** (NBFC) settles the beneficiary side and exchanges the required Travel-Rule data *privately, edge-to-edge* with the UAE anchor (see §9). |
| 8 | **Proof on demand** | Optional: "Share my transfer history with visa office." | **Selective disclosure** — Ravi can prove specific facts (e.g. "I sent ≥ X over 12 months") to one party without revealing amounts to anyone else. |

**The hard part is step 5** — those 8 seconds. That is where the app does something no payment app
in the world currently does: create mathematical proof a transfer is legal *without revealing the
amount*.

---

## 4. System Architecture

### 4.1 Components

```
┌─────────────────────────────────────────────────────────────────────┐
│  RAVI'S PHONE (React Native / Expo)                                   │
│  ┌───────────────┐   ┌────────────────────┐   ┌──────────────────┐    │
│  │ Wallet + UI   │   │ ZK Prover (WASM)   │   │ Secure enclave   │    │
│  │ (JS thread)   │──▶│ on native thread   │   │ ZK secret key +  │    │
│  │ progress bar  │   │ via JSI bridge     │   │ KYC credential   │    │
│  └───────────────┘   └─────────┬──────────┘   └──────────────────┘    │
└──────────────────────────────────┼───────────────────────────────────┘
                                    │  ~200-byte Groth16 proof + commitment
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STELLAR NETWORK                                                       │
│  ┌──────────────────────────┐     ┌───────────────────────────────┐   │
│  │ Soroban verifier contract│     │ Anchor network (SEP-compliant)│   │
│  │ • BN254 pairing check    │     │ • UAE anchor (deposit + KYC)  │   │
│  │ • nullifier registry     │     │ • IN anchor  (payout/NBFC)    │   │
│  │ • commitment store       │     │ • Travel-Rule data exchanged  │   │
│  └──────────────────────────┘     │   privately, edge-to-edge     │   │
│         only commitments,         └───────────────────────────────┘   │
│         nullifiers, proofs                                            │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼  proof artifact (court-admissible)
┌─────────────────────────────────────────────────────────────────────┐
│  REGULATOR  — sees "valid, KYC'd, within limits, not sanctioned".     │
│              NEVER sees ₹15,000 or the full identity chain.           │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 What lives where (the privacy boundary)

| Data | Lives where | Visible to whom |
|------|-------------|-----------------|
| Real amount (₹15,000) | Ravi's phone only | **Nobody else, ever** |
| ZK secret key | Phone secure enclave | Ravi only |
| KYC identity (passport, name, DOB) | Anchor's off-chain KYC store | The licensed anchor only |
| KYC **credential** (signed attestation) | Ravi's wallet | Used as *private* circuit input |
| **Commitment hash** | Stellar / Soroban | Public — but reveals nothing (one-way hash) |
| **Nullifier** | Soroban registry | Public — but unlinkable across transfers |
| **Groth16 proof** | Soroban + regulator | Public — proves facts, leaks no data |

The golden rule: **on-chain you only ever see commitments, nullifiers, and proofs — never amounts
or identities.**

---

## 5. How Zero-Knowledge Is Used

### 5.1 The three primitives to own deeply

**1. Commitment** — `commitment = hash(amount + secret_key)`
A scrambled fingerprint of the value. You can later verify a value matches it, but you **cannot
reverse it** to recover the amount. *This is what Stellar stores instead of the amount.*

**2. Nullifier** — `nullifier = Poseidon(secret_key, unique_transfer_id)`
A one-time stamp. Once published, it is recorded so the **same transfer can never be replayed** —
this is the double-spend protection. Because `unique_transfer_id` is freshly randomised per transfer,
two nullifiers from the *same* wallet look **completely unrelated** (see §7.3).

**3. Groth16 proof** — the actual proof system.
Written in **Circom** (a circuit language), compiled onto the **BN254** elliptic curve. The proof
asserts: *"I know a secret that opens this commitment, and the amount inside is within
[$1, $9,999]"* — without saying what the amount is. It is **~200 bytes**. The Soroban contract just
verifies this tiny proof: **cheap, fast, trustless.**

### 5.2 The commitment-+-proof model

When Ravi sends ₹15,000, the system does **not** write *"Ravi sent ₹15,000"* on-chain. It writes a
**commitment** (the scrambled fingerprint) **and** a separate **proof** that the commitment was
formed honestly and the hidden amount obeys the rules.

```
Private inputs (never leave phone):   amount, secret_key, KYC credential
                │
                ▼
        ┌───────────────┐
        │ Circom circuit │  ← the "mathematical rulebook"
        └───────┬────────┘
                ▼
Public outputs:  commitment, nullifier, "all rules passed"  +  ~200-byte proof
```

### 5.3 What the circuit actually checks (the three checks)

The circuit is a **mathematical rulebook**. It takes Ravi's secret inputs and verifies, in pure math
with no server and no human:

1. **Range check** — is the amount within legal limits? (FEMA inward-remittance limit, UAE reporting
   thresholds.)
2. **KYC check** — is the anchor's signature on Ravi's credential genuine? (verified *inside* the
   proof — see §7.1)
3. **Nullifier check** — has this exact transfer been spent before?

Output: a 200-byte certificate that says **"all three passed"** — provably, unfakeably — revealing
not a single number.

---

## 6. The Four Unsolved Technical Pieces (and how we solve each)

These are the parts nobody has shipped together. Solving all four simultaneously *is* the project.

### Piece 1 — The KYC attestation circuit

**Problem:** KYC is done off-chain by the anchor. How does the circuit know Ravi is KYC'd without
the circuit *seeing* his passport?

**Solution — an attested (selective-disclosure) credential.** When the anchor completes KYC, it signs
`sign(ravi_pubkey + kyc_level + expiry)` with the anchor's private key. Stored in Ravi's wallet,
never on-chain. When Ravi proves, the circuit takes this credential as a **private input** and
**verifies the anchor's signature *inside* the proof.** The public output is only: *"this user holds
a valid signed credential from an authorised anchor."* No passport number, no name, no DOB. This is
the critical piece that satisfies KYC regulation **without** storing identity on a blockchain.

### Piece 2 — The amount range proof

**Problem:** Prove "this amount ∈ [$1, $9,999]" without revealing it.

**Solution — bit-decomposition range proof.** The circuit decomposes the amount into binary, proves
each bit is 0 or 1, and proves the total does not exceed the limit. A few hundred constraints —
fast to generate, fast to verify. Output: *"amount ∈ [1, 9999]"* and nothing more.

### Piece 3 — The nullifier linkage problem

**Problem (subtle attack):** if Ravi sends two $500 transfers, do their two nullifiers reveal they
came from the *same* wallet? If so, a watcher could link Ravi's activity *without even knowing the
amounts.*

**Solution:** derive nullifiers as `Poseidon(secret_key, unique_transfer_id)` with a **fresh random
transfer ID per transfer.** Two nullifiers from the same wallet look entirely unrelated. The secret
key never appears on-chain. (Same construction Tornado Cash used correctly — but we wrap it in the
compliance layer they lacked.)

### Piece 4 — The trusted setup ceremony

**Problem:** Groth16 needs a one-time trusted setup. If the setup randomness ("toxic waste") leaks,
proofs can be **forged**.

**Solution — a Powers of Tau ceremony.** A multi-party computation where many participants each
contribute randomness; as long as **one** is honest and destroys their share, the setup is secure.
For testnet, SnarkJS has a built-in ceremony tool. For mainnet, run a **public** ceremony with the
ZK community — which doubles as **excellent marketing**, signalling cryptographic seriousness to
developers and investors.

---

## 7. The Three Hard Sub-Problems (engineering walls)

| # | Hard problem | Why it's hard | How we solve it |
|---|--------------|---------------|-----------------|
| **A** | **Prove compliance without revealing data** | "Verify without seeing" is impossible in normal systems. | The circuit takes private inputs (amount, identity), outputs public *"all rules passed"* flags + a court-admissible proof. The regulator gets legal certainty, never the data. |
| **B** | **Proof generation on a phone in real time** | Groth16 is heavy: thousands of elliptic-curve multiplications. 3–8s on laptop, **15–30s on a mid-range Android** — fatal for a payment app. | **(1) Pre-computation:** start witness generation the instant the "send" screen opens. **(2) Circuit minimisation:** prove *exactly* what regulators need, nothing more — lean circuit = fast proof. **(3) Native-thread execution:** compile prover to **WASM**, run it off the JS thread via Expo's **JSI bridge** so the UI stays alive; show an honest progress bar. *Users accept 8s if it feels intentional, not frozen.* |
| **C** | **The Travel Rule paradox** | FATF's Travel Rule (written 1996 for correspondent banking) says sender + receiver details must *travel with the funds, visible to every institution in the chain* — directly conflicting with private transfers. Ignoring it gets you sanctioned (Tornado Cash). | See §9 — the legal architecture that satisfies the rule *without* broadcasting data on-chain. |

> **The sharpest insight:** proof generation is the hardest **UX** problem, not the hardest
> *engineering* problem. This is where most ZK consumer apps die — and where getting it right is the
> biggest moat.

---

## 8. Why Stellar Specifically

Not marketing — concrete technical reasons:

1. **The fiat bridge already exists.** Stellar's **anchor network** provides licensed fiat on/off
   ramps in real corridors (UAE ↔ India). We do **not** build banking relationships from scratch —
   we plug into anchors that already hold the licenses.
2. **SEP standards are already documented.** Stellar Ecosystem Proposals (SEPs) are the shared
   protocol every anchor and wallet already speaks — think *UPI's standard API for the whole
   ecosystem*. Deposit, withdrawal, KYC handoff, and authentication all have ready-made SEP flows, so
   any compliant anchor integrates with us using standards they already implement.
3. **Soroban supports BN254.** Stellar's smart-contract platform (Soroban) has the **BN254 pairing
   operations** needed to verify Groth16 proofs cheaply and on-chain. The verifier is a small,
   fast contract.
4. **Cost + speed already solved.** Sub-cent fees, seconds-not-days settlement — Stellar was **built
   for this exact mission** (founded 2014: *"making money more fluid, markets more open, people more
   empowered"*).

> **The strategic point:** we are **not building a new payment network.** Stellar already solved
> speed, cost, and fiat access. We add the **one thing it lacks: privacy in transit.** That makes us
> a **collaborator** in Stellar's ecosystem, not a competitor — SDF has reason to fund us (we make
> their network more valuable), anchors have reason to integrate (we bring new users), and Ravi gets
> a better experience than anything at any price.

### A note on SEPs

SEP = **Stellar Ecosystem Proposal.** Like UPI's standard API: every bank/app speaks the same
protocol, so PhonePe can pay a Paytm user. SEPs do the same for Stellar — without them, every anchor
and wallet would invent its own way to talk, which is chaos. For us, SEPs answer: *how does Ravi's
app talk to the UAE anchor? what format does KYC data use? which URL? how does auth work?* — all with
one shared standard anchors already implement.

---

## 9. The Travel Rule Solution (the legal architecture)

This is the regulatory trap that kills most privacy projects — and the part that makes ours
**fundable and legally defensible.**

**The rule:** FATF Travel Rule requires originator + beneficiary information to travel with a
cross-border transfer, available to the institutions in the chain.

**The wrong way (what killed Tornado Cash):** ignore it entirely → sanctioned.

**The key insight that dissolves the paradox:** the rule says the data must be visible to *the
financial institutions in the chain* — **not** to the network rails, and **not** to "everyone." In
correspondent banking there are ~5 institutions, each seeing everything (the problem). In Prova there
are exactly **two regulated institutions: the originator anchor (UAE) and the beneficiary anchor
(India)** — and *both already did KYC anyway* (the UAE anchor verified Ravi; the India anchor is the
one paying out Amma). The blockchain and the app in the middle are **rails, not financial
institutions** — the rule never required them to see anything.

**Our approach — separate the two planes, and let the compliance data travel *sealed*:**

- **On the public chain:** only commitments, nullifiers, and proofs. No amounts, no identities.
- **Primary mechanism — the encrypted "sealed envelope" that travels with the proof.** Alongside
  the commitment, each transaction carries a small **encrypted blob** containing the required
  Travel-Rule data (originator + beneficiary details in the standard **IVMS101** format),
  **encrypted to the beneficiary anchor's public key.** It *literally travels with the funds* — exactly
  what the rule's wording demands — but **only the licensed India anchor can decrypt it.** The chain,
  the app, and any watcher see only ciphertext. This is the project metaphor made real: a sealed
  letter only the correct post office can open. *(This is the "stamp" of Prova — the proof — riding
  next to a sealed envelope only the regulated recipient can read.)*
- **Fallback / interop — VASP-to-VASP off-chain messaging.** For anchors that require the established
  industry pattern, the two anchors exchange the same IVMS101 data **directly and off-chain** via a
  standard Travel-Rule protocol (e.g. Notabene / TRP / TRUST), keyed by transfer ID. Conservative,
  already accepted by regulators, and a safe compatibility path.
- **The ZK proof** lets the *network* accept the transfer as legitimate without seeing the data,
  while the *edges* hold (and only they can read) the identity data the rule actually requires.

So the rule is satisfied (the two obligated institutions exchange the mandated data — sealed, in
transit), and the public corridor stays private. The first team to get a **regulator opinion letter**
(RBI / CBUAE) confirming this satisfies the Travel Rule **owns that precedent** — a core moat (§11).

---

## 10. Why Every Other Ecosystem Failed

The pattern is the same failure said four ways: **each picked one dimension and ignored the other
two.**

| Project | ZK privacy | Compliance mechanism | Fiat rails / consumer product | Result |
|---------|:---:|:---:|:---:|--------|
| **Tornado Cash** | ✅ (great mixer) | ❌ none | ❌ | **Sanctioned** |
| **Zcash** | ✅ (invented Groth16) | ⚠️ potential | ❌ no fiat bridge | Nobody can use it to send money home |
| **Monero** | ✅ | ❌ none | ❌ | No compliance path at all |
| **Aztec** | ✅ (advanced private contracts) | ⚠️ potential | ❌ no consumer product | Powerful, but no Ravi |
| **Western Union** | ❌ (5 firms see amount) | ✅ | ✅ | No privacy, high fees |
| **Prova (us)** | ✅ | ✅ proof-based | ✅ Stellar anchors + consumer app | **All three, on one corridor** |

> Ours is the **first** time someone combines **ZK privacy + real fiat rails (Stellar anchors) + a
> compliance-proof mechanism regulators accept** into a single consumer corridor, for one specific
> person: **Ravi sending money to Amma.**

The honest reason it hasn't been done: the technical insight and the *distribution* insight
(integrating licensed institutions, regulatory sign-off, a product a construction worker in Sharjah
can use on a bus) have **never lived in the same product at the same time.**

---

## 11. The Moat — Why This Can't Be Copied

The ZK math is open source — that's the **entry ticket**, not the moat. The moat is four things that
take years to assemble:

1. **Anchor partnerships.** A UAE-licensed exchange + an Indian NBFC both implementing Prova's
   compliance-proof format requires legal agreements, regulatory sign-offs, and earned trust. A
   competitor can copy the code on day one but **cannot copy those anchor relationships.**
2. **The trusted-setup ceremony.** Once a public Powers-of-Tau ceremony has been run with many
   participants, the proving key is trusted. A copycat must run their own *and* earn community
   trust — slow, reputational.
3. **Regulatory clarity.** First team with a clear RBI/CBUAE opinion that their ZK proof satisfies
   the Travel Rule **owns the precedent.** Regulators don't re-evaluate the same question twice.
4. **User trust.** Remittances are deeply personal — Ravi is trusting the product with his mother's
   grocery money. Trust is earned over dozens of reliable transfers, not a whitepaper.

> The ZK math is the entry ticket. **Everything else is the actual business.**

---

## 12. The Tech Stack

| Layer | What it does | Tool / tech |
|-------|--------------|-------------|
| **Circuit** | The compliance rulebook (range + KYC-sig + nullifier) | **Circom**, compiled to **BN254** |
| **Proof system** | Tiny, fast, ~200-byte proofs | **Groth16** via **SnarkJS** |
| **Trusted setup** | Generate proving/verification keys safely | **Powers of Tau** (SnarkJS testnet → public ceremony mainnet) |
| **On-chain verifier** | Verify proof, record nullifier, store commitment | **Soroban** smart contract (BN254 pairing) |
| **Settlement / fiat rails** | Deposit, payout, KYC handoff, Travel-Rule edge exchange | **Stellar anchors** via **SEP** standards |
| **Mobile app** | Wallet, send flow, honest progress UX | **React Native / Expo** |
| **On-device proving** | Run prover without freezing UI | **WASM prover** on a **native thread via JSI bridge** |
| **Key custody** | Hold ZK secret + KYC credential | Phone **secure enclave** |

---

## 13. Build Sequence (phased, single-corridor first)

> The biggest mistake is building all five layers simultaneously. Each phase below ships a working
> artifact and de-risks the next. Because the underlying ZK and Stellar primitives already exist
> independently, Phases 1–2 are an **integration** effort, not invention.

1. **Phase 1 — Core ZK on testnet.** Circom circuit (range + nullifier) + SnarkJS testnet setup +
   Soroban verifier. Goal: a proof verifies on Stellar testnet.
2. **Phase 2 — Stellar rails + commitment store.** Wire commitments/nullifiers into Soroban; deposit
   via a testnet anchor flow.
3. **Phase 3 — KYC attestation circuit.** Anchor-signed selective-disclosure credential verified
   *inside* the proof. This is the compliance breakthrough.
4. **Phase 4 — Mobile prover UX.** WASM prover on native thread, pre-computation, honest progress
   bar. *This is where ZK consumer apps live or die.*
5. **Phase 5 — Real corridor + ceremony.** One licensed UAE anchor + one Indian NBFC, public Powers
   of Tau, Travel-Rule edge exchange, regulator opinion letter.

---

## 14. What Makes It *Extraordinary* (beyond baseline)

Three things to design for from day one, even if shipped later:

1. **Selective disclosure.** Let Ravi prove his payment history to a visa officer (e.g. "sent ≥ X
   over 12 months") *without revealing amounts to anyone else.* No remittance product has this.
2. **Proof aggregation.** Batch ~50 proofs into a single on-chain verification → fees drop ~50× as
   the network scales. Design the contract for it early (build it in Phase 3+).
3. **Compliance-proof-as-an-API ("Prova Inside").** Turn the compliance-proof *format* into an API
   and sell it to other remittance companies on Stellar. This transforms Prova from a single app into
   the **infrastructure layer the ecosystem relies on** — a fundamentally more valuable business.

---

## 15. Risks & Open Questions

| Risk | Mitigation / status |
|------|---------------------|
| **Proof latency on low-end phones** | Pre-computation + lean circuit + native thread; target ≤ 8s perceived. Still the #1 product risk. |
| **Regulator acceptance of ZK-as-compliance** | Opinion letter is a milestone, not a given. Edge-anchor Travel-Rule exchange is the conservative, defensible design. |
| **Anchor onboarding is slow** | Start with one corridor (UAE→IN), one anchor each side. Don't boil the ocean. |
| **Trusted-setup trust** | Public Powers of Tau ceremony; transparency as marketing. |
| **Cross-border legal complexity (FEMA, CBUAE)** | Limit scope to one corridor and within-limit amounts initially. |
| **Stellar/Soroban BN254 maturity** | Validate gas cost + pairing support on testnet in Phase 1 before committing. |

---

## 16. Proof-of-Concept / Demo Scope

A minimal end-to-end demonstration that validates the core claim:

**Minimum lovable demo:**
1. A Circom circuit proving `amount ∈ [1, 9999]` + a nullifier, with SnarkJS testnet setup.
2. A Soroban contract on **Stellar testnet** that verifies the proof and stores the commitment +
   nullifier (and rejects a replayed nullifier).
3. A simple mobile/web "send" screen showing the **honest progress bar** and, on success, a block
   explorer link showing **a commitment — and no amount.**
4. A one-screen "regulator view" that shows only `valid / KYC'd / within-limits / not-sanctioned`.

That demo tells the whole story: *money moved, the chain proves it's legal, and the amount is
nowhere to be found.*

---

## 17. Glossary (plain language)

- **Zero-knowledge (ZK) proof** — prove a statement is true without revealing the secret behind it.
- **Commitment** — `hash(amount + secret)`: a one-way fingerprint of a value. Verifiable, irreversible.
- **Nullifier** — a one-time stamp that prevents replaying the same transfer; unlinkable across transfers.
- **Circom** — a language for writing ZK circuits (the "rulebook").
- **Groth16** — the proof system producing tiny (~200-byte) proofs that verify fast.
- **BN254** — the elliptic curve the proofs use; Soroban supports its pairing operations.
- **Soroban** — Stellar's smart-contract platform; runs our on-chain verifier.
- **Anchor** — a licensed institution that bridges fiat ↔ Stellar (deposits, payouts).
- **SEP (Stellar Ecosystem Proposal)** — the shared protocol anchors and wallets speak (like UPI's API).
- **Travel Rule** — FATF rule requiring sender/receiver info to travel with cross-border funds.
- **Powers of Tau** — multi-party ceremony that safely generates Groth16's setup keys.
- **Selective disclosure credential** — prove a fact about your identity (e.g. "KYC'd") without revealing the identity data.

---

*Prova applies zero-knowledge compliance proofs to Stellar's payment rails to serve the largest
real-world use case for both technologies: the **$800B global remittance market**.*

*Name: **Prova** — "proof." The proof is the product; everything else is plumbing.*
