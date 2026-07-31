# Sign-up, identity, validation, rate limiting & email

> What changed in sign-up, where every field is validated, how abuse is throttled, how codes are
> emailed, what users actually see when something goes wrong, how to check each part by hand, and
> what is deliberately still open.

---

## 1. What changed, and why

| Before | Now | Why |
|---|---|---|
| Sign in with **phone + OTP** | Sign in with **email + OTP** | Email is a stable account identifier. Phone numbers change — tying the account to one means a user who switches SIM loses their wallet |
| Onboarding asked for a **name** | It does not | The name is compliance data the anchor needs, not something the app needs to let you in |
| Home screen greeted you **by name** | It does not | Putting a real name on the home screen of a privacy product is the wrong signal |
| Name/phone at sign-up | Collected at **verification step 1** | They are needed for compliance and payout contact, so they belong with the identity check |
| Validation duplicated app-side and server-side | **One frozen spec in `shared/`** | Two copies drift, and drift means a sign-up that works on one path and silently fails on the other |
| **No rate limiting at all** | Per-IP + per-identifier quotas and cooldowns | Every endpoint is unauthenticated; without limits a script drains the SMS budget or brute-forces a 6-digit code in minutes |

### The phone number is captured, not verified

There is **no OTP round-trip on the phone number**, by decision.

The phone is **not a regulatory identity field**. The Travel Rule set — see `IVMS101Person` in
`shared/src/ivms101.ts` — is name, date of birth, country of residence, and a national identifier.
All of those come from the ID document and selfie in the following steps. A phone number proves
nothing about who someone is; anyone can buy a SIM. What a regulator expects is *a* verified contact
channel, and the **email proved at sign-in satisfies that**.

So the number is stored as **user-asserted**. Until phone OTP is wired:

- Do **not** use it for fraud scoring or as a second factor.
- Do **not** call it "verified" in user-facing or compliance-facing copy.

The backend endpoints already exist, are validated, are rate-limited, and are tested
(`POST /kyc/phone/request`, `POST /kyc/phone/verify`) — see §9.

> **This is a product decision, not a legal opinion.** The binding requirements come from your
> licensed anchor and your compliance counsel. What is established here is that the phone is absent
> from the regulatory data set, so the question is anchor requirements and fraud posture, not
> compliance breach.

---

## 2. The new flow

```
Sign up ──► email ──► 6-digit code ──► create wallet ──► set PIN ──► app
                                        (no name asked)

Verify identity ──► STEP 1: name + country + phone   ← new
                ──► STEP 2: ID front
                ──► STEP 3: ID back (skippable for passports)
                ──► STEP 4: selfie
                ──► provider verdict ──► credential issued
```

### Phone entry

Pick a country → its dial code appears → type **only the national digits**.

| Country | National digits |
|---|---|
| India | 10 |
| UAE, Saudi Arabia, Sri Lanka | 9 |
| Everything else in the list | 10 |

> **You asked for 10 digits.** That is right for India, but the UAE is **9** — and the UAE is the
> *sending* side of the corridor. A single hardcoded length would have rejected every valid UAE
> number, so the length is per-country. The field caps input at that country's length, and switching
> country clears it, since digits typed for the previous one are almost certainly wrong now.

Leading zeros are rejected: users type the trunk prefix out of habit, and keeping it produces an
unreachable E.164 number.

---

## 3. One validation spec, two languages

Rules live in **`shared/src/validation.ts`**, mirrored exactly in
**`shared/go/schema/validation.go`**.

- **Client-side validation is a courtesy.** It makes a form pleasant.
- **Server-side validation is the control.** Anything can post to the API.

Both sides have suites over the **same cases** (`shared/src/validation.test.ts`,
`validation_test.go`), so a rule tightened on one side fails a test rather than reaching production.

| Rule | Function | Notes |
|---|---|---|
| Email | `isValidEmail` | Practical, not RFC 5322 — the address is only *proved* when the code arrives |
| Email normalisation | `normalizeEmail` | Trimmed + lowercased, so case cannot create two accounts |
| Name | `isValidName` | 2–60 chars, Unicode letters **and combining marks** |
| Name normalisation | `normalizeName` | Collapses internal whitespace |
| OTP | `isValidOtp` | Exactly 6 digits |
| National phone | `isValidNationalNumber` | Per-country length, no leading zero |
| E.164 composition | `toE164` | Strips separators, re-checks the rules |
| E.164 received | `isValidE164` | `+` then 8–15 digits |
| E.164 supported | `isSupportedE164` | Must match a listed country exactly |
| Wallet identifier | `isValidUserId` | 32-byte lowercase hex |
| Field element | `isValidHex32` | Commitments, nullifiers, roots |
| Stellar address | `isValidStellarAddress` | `G` + 55 base32 chars |
| KYC tier | `IsValidTier` (Go) | 1, 2 or 3 |

### A bug this surfaced: Indic names were rejected

The old rule was `\p{L}` — Unicode **letters** only. In Bengali, Devanagari, Tamil and most Indic
scripts, vowel signs (matras) are **marks**, not letters. So **`সৌমেন` was rejected** as "use letters
only".

That silently locks out a large share of this corridor, and nobody reports it — they abandon the
form. Both sides now accept `\p{L}` plus `\p{M}` (Go: `unicode.IsMark`), pinned in both suites.

---

## 4. Server-side validation, endpoint by endpoint

Gaps found and closed in this pass are marked **fixed**.

| Endpoint | Validates | Status |
|---|---|---|
| `POST /auth/otp/request` | email | rewritten for email |
| `POST /auth/otp/verify` | email **and** code | re-checks the address, not just the code — a client can post a code against an address it never requested |
| `POST /kyc/phone/request` | supported E.164 | built, not yet used by the app |
| `POST /kyc/phone/verify` | supported E.164 + code | built, not yet used |
| `GET /countries` | — | served from the same table the server validates against |
| `POST /kyc/verifications` | `userId` shape, `tier` range | **fixed** — accepted any string and any integer |
| `GET /kyc/verifications/{userId}` | `userId` shape | **fixed** — only checked non-empty |
| `POST /kyc/verifications/{userId}/decide` | `userId` shape, decision enum | **fixed** — anything other than `approved` silently meant *reject* |
| `POST /kyc/credential` | `userId` shape | **fixed** — only checked non-empty |
| `POST /kyc/credential/renew` | `userId` shape | **fixed** — validated **nothing at all** |
| `GET /wallet/{address}` | Stellar address shape | **fixed** — accepted any non-empty string |
| `POST /wallet/fund` | Stellar address shape | **fixed** |
| `POST /wallet/trustline/prepare` | Stellar address shape | **fixed** |
| `POST /wallet/trustline/submit` | address + xdr + signature | **fixed** (address was unchecked) |
| `POST /transfers` | proof blob parsed and shape-checked | already correct |
| `POST /pool/spend` | proof length, root, nullifier | already correct |
| `GET /pool/path/{commitment}` | 32-byte hex | already correct |
| `POST /pool/spent` | every nullifier is 32-byte hex | already correct |
| `GET /pool/notes` | numeric cursor and limit | already correct |
| All bodies | size-capped via `MaxBytesReader` | already correct |

### Why the `userId` gaps mattered

`userId` is `Poseidon(ownerSk, domain)` — an opaque hash with a **known shape**. Accepting free text
meant anything could become a row in the verification table. That table is the KYC audit trail: the
one record a regulator will actually ask to see.

### What the backend deliberately does *not* validate

**Name and phone never reach the backend.** They live on-device in the session, because the backend
holds no PII by design (`Docs/kyc-verification.md` §3) — identity data reaches the anchor through its
own vendor. There is nothing server-side to validate because nothing is sent.

**Amounts, commitments and proofs are not string-validated.** They are enforced by the circuit and
the contract — a far stronger guarantee than any format check. See `Docs/shielded-pool.md`.

---

## 5. Rate limiting

Previously **absent entirely**. Every endpoint is unauthenticated by design, so this was the gap
between a script and the SMS bill.

### Two layers

- **Per-IP**, on every route: a blunt ceiling on one source.
- **Per-identifier**, on the OTP paths: an attacker rotating IPs still cannot hammer one address, and
  a real user on a shared NAT is not punished for their neighbours.

### Two controls, because they stop different things

- **Quota** (N per window) bounds total volume.
- **Cooldown** (a minimum gap for the same identifier) stops the bursts a quota alone permits. This
  is what actually makes code-guessing impractical.

### The limits

| Scope | Limit | Why |
|---|---|---|
| Any IP, all routes | 300 / min | Blunt ceiling |
| OTP request, per IP | 20 / hour | Caps one source's share of the bill |
| OTP request, per address | 5 / hour | Nobody legitimately needs six codes an hour |
| OTP request cooldown | 60 s | "Resend" is not a hammer; the first code needs time to arrive |
| OTP verify, per address | 10 / hour | A 6-digit code is 10⁶ — this makes exhaustive search ≈ 11 years |
| OTP verify cooldown | 2 s | Stops ten instant guesses inside one window |
| Pool reads, per IP | 120 / min | `/pool/notes` and `/pool/path` rebuild a Merkle tree — cheap to ask, expensive to serve |

### Design decisions worth keeping

**Redis-backed, with an in-process fallback.** Redis keeps limits consistent across replicas. When it
is unavailable the limiter degrades to per-instance counters rather than failing open — a security
control that silently disables itself when a dependency wobbles is worse than none, because nobody
notices.

**Validation runs before rate limiting.** Malformed input is rejected first, so an attacker cannot
exhaust a victim's quota with junk and lock them out. Tested.

**`X-Forwarded-For` is ignored by default.** Trusting it unconditionally makes every per-IP limit
bypassable with one header — the standard way IP rate limiting is defeated. Enable
`TRUST_PROXY_HEADERS=true` **only** behind a proxy you control that overwrites the header.

**Health checks are exempt.** Load balancers poll them constantly; throttling a liveness probe is how
a healthy service gets pulled out of rotation.

**Rate limiting sits inside logging.** A throttled request is still logged — otherwise an attack is
invisible in the very logs you would use to spot it.

**Standard headers.** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every response
and `Retry-After` on a 429, following the IETF draft, so well-behaved clients back off *before* being
blocked.

---

## 6. Email delivery (real codes)

Sign-in codes are **actually emailed** when SMTP is configured. Free with Gmail over SMTP — Go's
stdlib `net/smtp` does the job, so there is no dependency to audit. (Nodemailer is the Node
equivalent; same protocol.)

### Gmail setup

Gmail needs an **App Password**, not the account password — Google removed "less secure app access"
in 2022, so an ordinary password is simply refused.

1. Enable **2-Step Verification** on the Google account.
2. **Google Account → Security → App passwords** → generate one for *Mail*.
3. Put the 16-character value in `SMTP_PASSWORD`.

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=you@gmail.com
SMTP_PASSWORD=xxxxxxxxxxxxxxxx
SMTP_FROM=you@gmail.com          # Gmail requires this to match SMTP_USERNAME
SMTP_FROM_NAME=Prova
```

Leave `SMTP_HOST` empty to keep using `DEV_OTP`.

### What the code store guarantees

The dev stub compared against a constant. A real code needs five properties, and missing any one
makes the others close to worthless:

| Property | How |
|---|---|
| **Unpredictable** | `crypto/rand` over the exact range — `n % 1000000` would bias the low end and shrink the search space |
| **Stored hashed** | SHA-256, bound to the identifier, so a Redis dump reveals no live codes and a code cannot be replayed against another address |
| **Expiring** | 10 minutes |
| **Attempt-capped** | 5 wrong guesses **destroy** the code — rate limiting slows an attacker, this removes the target |
| **Single-use** | Consumed on success, so a code seen in transit cannot be replayed |

Comparison is constant-time. Requesting a new code invalidates the previous one, so "resend" cannot
leave two valid codes in flight.

### Behaviour by configuration

| SMTP | `AUTH_MODE` | What happens |
|---|---|---|
| configured | either | A real random code is emailed. `DEV_OTP` **stops working** |
| absent | development | `DEV_OTP` is accepted; the flow works offline |
| absent | production | Sign-in is **refused** with a clear message, rather than accepting a code that was never sent |

The app now **always calls the backend** for codes, so development exercises the shipping path. The
only local fallback is an unreachable server in dev mode.

### Failing loudly

A misconfigured deployment logs at start-up:

```
SMTP is not configured and AUTH_MODE=production — sign-in will be refused
```

The provider's internal error is never shown to the user or written next to their address in logs.

---

## 7. Error messages users actually see

Previously the app threw `Error('/auth/otp/request → 429')` and rendered it straight into a toast —
so a rate-limited user was shown a URL and a status code.

The client now parses the `{code, message}` envelope and surfaces the server's own text, which is
written for a person to read.

| Situation | What the user sees |
|---|---|
| Invalid email | *Enter a valid email address* |
| Resend too soon | *Please wait before requesting another code* + a live `Resend code in 42s` countdown |
| Too many codes | *Too many codes requested for this account. Try again later.* |
| Wrong code | *That code isn't right. 3 attempts left.* |
| Last attempt | *That code isn't right. One attempt left before you'll need a new code.* |
| Attempts exhausted | *Too many incorrect attempts. Request a new code.* |
| Expired / already used | *That code has expired. Request a new one.* |
| Guessing too fast | *Too many attempts. Please wait a moment.* |
| Mail provider down | *We couldn't send your code. Check the address and try again.* |
| SMTP absent in production | *Email sign-in is not available right now. Please try again later.* |
| No connectivity | *Can't reach Prova. Check your connection and try again.* |

Three details that matter more than they look:

- **Remaining attempts are stated.** It turns a dead end into a recoverable mistake, and it warns a
  real user that someone else may be guessing at their account.
- **A rejected code clears the field**, because it is almost always a typo.
- **The resend button shows a countdown** driven by `Retry-After`, so the limit explains itself
  instead of failing when tapped.

---

## 8. How to check this by hand

### Automated first

```bash
cd shared    && npm test          # 12 TS validation cases
cd shared/go && go test ./...     # the same cases in Go
cd backend   && go test ./...     # endpoint validation + rate limiting
cd mobile    && npx tsc --noEmit  # types
```

### Sign-up

1. **Launch → Get started.** You land on **"What's your email?"**, not a phone screen.
2. **Type `notanemail` → Continue.** *Enter a valid email address*. Nothing is sent.
3. **Valid address → Continue.** The code screen reads *Sent to \<your address\>*.
4. **Enter `12345`.** *Code must be 6 digits*.
5. **Enter `000000`.** You reach **"Create your wallet"** — confirm there is **no name field**.
6. **Create wallet → set PIN → home.** The header reads **"Prova"**, with **no "Hi, \<name\>"**.

### Identity step

7. **Verify identity → Start verification.** Step 1 of 5 is **"Your details"**.
8. **Empty name → Continue.** *Name is required*.
9. **`Ravi123` → Continue.** *Use letters only*.
10. **`সৌমেন`.** **Accepted** — this is the Indic-name fix.
11. **Country defaults to 🇦🇪 +971**, hint *9 digits, without the leading 0*.
12. **8 digits → Continue.** *United Arab Emirates numbers are 9 digits*.
13. **`012345678`.** *Drop the leading 0*.
14. **Switch to 🇮🇳 +91.** The field **clears**, hint becomes *10 digits*.
15. **10 digits → Continue.** You advance to ID capture (step 2 of 5).

### Server-side

```bash
API=http://localhost:8080

# Rules are enforced server-side, not just in the app.
curl -s -X POST $API/auth/otp/request -d '{"email":"notanemail"}'       # 400
curl -s -X POST $API/auth/otp/request -d '{"email":"a@example.com"}'    # 200

# The address is re-checked on verify, not only the code.
curl -s -X POST $API/auth/otp/verify -d '{"email":"nope","code":"000000"}'   # 400

# Case cannot create two accounts.
curl -s -X POST $API/auth/otp/verify -d '{"email":"User@Example.COM","code":"000000"}'
# → {"token":"…","email":"user@example.com"}

# Previously accepted anything:
curl -s -X POST $API/kyc/credential/renew -d '{"userId":"whatever"}'    # 400
curl -s -X POST $API/wallet/fund -d '{"address":"not-an-address"}'      # 400

# Unknown tiers refused.
curl -s -X POST $API/kyc/verifications \
  -d '{"userId":"'$(printf 'ab%.0s' {1..32})'","tier":99}'             # 400
```

### Email delivery

```bash
# With SMTP unset, the dev code comes back in the response:
curl -s -X POST $API/auth/otp/request -d '{"email":"you@example.com"}'
# → {"status":"sent","devCode":"000000"}

# With SMTP set, a real code is emailed and NOTHING is echoed:
curl -s -X POST $API/auth/otp/request -d '{"email":"you@gmail.com"}'
# → {"status":"sent"}          ← check the inbox

# The dev constant stops working once real codes are in play:
curl -s -X POST $API/auth/otp/verify -d '{"email":"you@gmail.com","code":"000000"}'
# → 401 "That code isn't right. 4 attempts left."

# Five wrong guesses destroy the code — even the correct one then fails:
# → "Too many incorrect attempts. Request a new code."
```

In the app: request a code, check the inbox, and confirm the **subject line carries the code** (many
clients surface it without opening the mail). Type it wrong once and confirm the toast names the
remaining attempts. Tap **Resend** twice and confirm the second shows a live countdown.

### Rate limiting

```bash
# Cooldown: the second request within 60s is refused.
curl -s -X POST $API/auth/otp/request -d '{"email":"rl@example.com"}'   # 200
curl -si -X POST $API/auth/otp/request -d '{"email":"rl@example.com"}' | head -1
# → HTTP/1.1 429  (with Retry-After)

# Budget is advertised on every response.
curl -si $API/countries | grep -i ratelimit
# → RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset

# Guessing is throttled.
for i in 1 2 3; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/auth/otp/verify \
    -d '{"email":"guess@example.com","code":"111111"}'
done
# → 401 then 429

# Health checks are never throttled.
for i in $(seq 400); do curl -s -o /dev/null -w "%{http_code} " $API/healthz; done | tr ' ' '\n' | sort -u
# → 200 only
```

---

## 9. Still open

| Item | Impact | Notes |
|---|---|---|
| **Phone OTP not wired** | The stored number is user-asserted, not proved | Endpoints exist, validated, rate-limited, tested. The app needs a code stage in `KycIdentityStep`; then mark it verified in the session |
| **No SMS provider** | The phone step's endpoints return **501** | Only affects phone OTP, which is not wired to the app anyway |
| **Gmail caps at ~500 emails/day** | Fine for testnet, not for launch | Move to a transactional provider (Resend, Postmark, SES). Only `SMTP_*` changes — no code |
| **No SPF/DKIM/DMARC on a custom domain** | Codes may land in spam | Not an issue on `@gmail.com`; required once sending from your own domain |
| **Rate limits are per-instance without Redis** | Weaker with Redis down | By design — degraded beats open. Run Redis in production and alert if it drops |
| **No CAPTCHA / proof-of-work** | A distributed botnet can still exhaust per-identifier quotas | Rate limiting alone does not stop enumeration at scale. Revisit if abuse appears |
| **Existing testnet users must re-verify** | Their credential is bound to the old identity | KYC now binds to the pool spending key (`Docs/shielded-pool.md` §10.8) |
| **Old sessions carry top-level `phone`/`name`** | Profile screen may look odd | Fields are optional now; reinstall or restore fixes it. Not worth a migration pre-launch |
| **Country list is 11 entries** | Anyone outside cannot enter a number | Extend `COUNTRIES` in **both** `validation.ts` and `validation.go` — the parity tests enforce it |
| **Address & DOB not collected in-app** | Both are Travel Rule fields | By design: extracted from the ID by the vendor. **Worth confirming with your anchor that their vendor reliably returns both** — a bigger compliance dependency than the phone ever was |

---

## 10. If you add phone OTP later

Everything server-side is done, including rate limiting. To wire it:

1. In `mobile/src/features/kyc-identity.tsx`, restore a `code` stage after the details stage: call
   `requestPhoneOtp(e164)` on Continue, then `verifyPhoneOtp(e164, code)` before `onCaptured`. Both
   are already exported from `src/lib/api.ts`.
2. Add `phoneVerified: boolean` to `Session`, set only on a successful verify.
3. Update this document and drop the "user-asserted" caveats.
