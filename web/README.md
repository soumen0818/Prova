# Prova Web

The public site and the operator console, in one Next.js application.

Two audiences, one deployment:

| Path                                                             | Who it is for  | How it is protected                             |
| ---------------------------------------------------------------- | -------------- | ----------------------------------------------- |
| `/`, `/about`, `/how-it-works`, `/contact`, `/privacy`, `/terms` | Everyone       | Public, indexed                                 |
| `/ops/*`                                                         | The Prova team | Email + password, signed session, never indexed |

---

## Why one app and not two

The console is three pages that read a queue and post a decision. Standing up a second deployment,
a second domain and a second pipeline for that would cost more than it protects — and it would not
protect anything, because the boundary that matters is the session check, not the hostname.

Nothing on the public site links to `/ops`. It does not appear in the navigation, the footer, the
sitemap or `robots.txt`'s allow list. That is not the security — the password and the signed session
are — but there is no reason to advertise a staff door on a marketing page.

---

## How the console reaches the backend

Every console page renders on the server and calls the Go backend from there, through
`src/lib/backend.ts`.

That is deliberate. Those endpoints are gated by `COMPLIANCE_TOKEN`, the secret that can approve
anybody's KYC. A browser-side fetch would put it in devtools, in extensions, and in anything else
running on the page. Rendering on the server keeps it on the server — and as a side effect there is
no CORS to configure, because the backend is never contacted from an origin at all.

```
browser ──► Next.js server ──(Bearer COMPLIANCE_TOKEN)──► Go backend /ops/*
```

---

## Getting in

Two ways, and they are the same door:

1. **Triple-tap the Prova symbol in the site footer.** No label, no link, nothing a visitor would
   ever hit by accident — but nothing to remember either, and it works on a phone.
2. **Go to `/ops` directly.**

Neither is a security control; anyone can type a URL. What protects the console is the sign-in
below. Hiding the entrance only keeps it off a marketing page.

## Sign-in

An email and a password, both from the environment, no user accounts. One person runs this console
today; per-user accounts would mean a user table, an invite flow and a reset flow, all to
distinguish one operator from themselves.

- `OPS_EMAIL` and `OPS_PASSWORD` are both checked, in constant time, and never leave the server.
- Both comparisons always run before the result is combined, so the response time does not reveal
  which half was wrong.
- The session cookie holds **no credential** — only an expiry and an HMAC over it, keyed by
  `OPS_SESSION_SECRET`. A stolen cookie cannot be extended, and cannot be forged without the secret.
- `httpOnly`, `sameSite=strict`, and `secure` outside development.
- Sessions last 8 hours.
- **Either credential unset denies everything.** Treating "nothing configured" as "nothing
  required" would turn a missing environment variable into an open console.
- Every failure returns one message. Saying which half was wrong tells someone guessing that the
  other half was right.

Every server action re-checks the session itself. A server action is a public POST endpoint, so
"the layout already checked" is not a check.

When a second person joins, the thing to add is real accounts — not a second shared password. The
audit log already has an `actor` column waiting for a name.

---

## What the console shows

**Verifications** (`/ops/kyc`) — the review queue, defaulting to what is waiting. Approve, or reject
with a reason. The reason matters: it decides the message the user sees, and whether they are
allowed to try again at all. Four reasons are terminal (sanctions, duplicate identity, underage,
tampered document) and the button says so before you press it.

**Conversations** (`/ops/support`) — messages from people using the app, newest activity first.
Replies appear in the app's chat screen within about five seconds. Closing a conversation is filing,
not locking: the next message from the user reopens it.

Website contact-form enquiries land here too, filed under an id derived from the sender's email, so
one person writing twice continues one thread. Those senders have no app to read a reply in — answer
them from your email client.

Everyone is identified by an opaque wallet hash. There is no name, email or document anywhere in
this system to show instead — that is the design, not a gap in these screens.

---

## Setup

```bash
cp .env.example .env.local
# fill in OPS_PASSWORD and OPS_SESSION_SECRET (openssl rand -hex 32)
npm install
npm run dev            # http://localhost:3000
```

The console needs the Go backend running with Postgres. Without it the pages render and say so
rather than showing an empty queue, which would read as "no work waiting".

| Variable             | Needed for        | Notes                                             |
| -------------------- | ----------------- | ------------------------------------------------- |
| `PROVA_API_URL`      | Console           | Defaults to `http://localhost:8080`               |
| `OPS_EMAIL`          | Console sign-in   | Unset = nobody can sign in                        |
| `OPS_PASSWORD`       | Console sign-in   | Unset = nobody can sign in                        |
| `OPS_SESSION_SECRET` | Console sign-in   | `openssl rand -hex 32`; changing it signs you out |
| `COMPLIANCE_TOKEN`   | Console → backend | Must equal the backend's `COMPLIANCE_TOKEN`       |

The marketing pages need none of these and build without any of them set.

## Commands

```bash
npm run dev        # development server  (output: .next-dev)
npm run build      # production build    (output: .next)
npm run start      # serve the production build
npm run typecheck  # tsc --noEmit
npm run format     # prettier --write .
```

Dev and production write to **different** output directories on purpose. Sharing one meant a
`next build` run while `next dev` was up would overwrite the dev server's chunks underneath it, and
the next hard refresh died with `Cannot find module './195.js'` — a baffling error that survived
until you deleted `.next` by hand. `next start` still reads `.next`, so deployment is unchanged.

---

## The public pages

| Page            | What it is for                                                            |
| --------------- | ------------------------------------------------------------------------- |
| `/`             | The pitch: privacy claims, how it works in four steps, download           |
| `/about`        | Why Prova exists, and an honest account of how early it is                |
| `/how-it-works` | The four steps, then a table of exactly what leaves the phone at each one |
| `/contact`      | Form (name, email, message) plus real contact details                     |

Contact details live in `src/lib/site.ts` — one definition, imported everywhere. Postal address and
phone render only when set, so they stay off the page until there is a real one to publish.

To ship the Android build: drop the file at `public/prova.apk` and set `APK_URL` in that same file.
The download section switches itself from "not ready yet" to a real button.

## Legal pages

`/privacy` and `/terms` render from `@prova/shared`, the same module the mobile app's Legal screen
reads. There is one copy of that text. A policy that says different things in two places is
unenforceable and, where the difference matters, dishonest — so editing it in `shared/src/legal.ts`
updates the app and the site together.
