-- Accounts: the first identity this backend keeps.
--
-- Everything before this migration was deliberately identity-free — the KYC record held an opaque
-- `user_id` and nothing else, and sign-in codes lived in Redis and expired. Two operational needs
-- changed that decision:
--
--   1. A reinstall wipes the device, and the app cannot tell a returning user from a new one. Without
--      that signal it starts a fresh sign-up, silently abandoning a wallet whose backup could have
--      been restored. Knowing the address has been seen before is what routes them to restore.
--   2. A reviewer approving a verification sees only a hash, which is not a review.
--
-- What this does NOT change: nothing here appears on-chain. A spend proof's public inputs are the
-- Merkle root, nullifier, commitments, amount, destination, anchor key, time and the encrypted note
-- (see POOL_PUBLIC_INPUTS) — `user_id` is proved inside the circuit and never published. So linking
-- an address to a `user_id` does not make anyone's transfers linkable.
--
-- It does mean this database now holds personal data, with the obligations that brings: deletion on
-- request, and a breach here identifies users where before it could not.

CREATE TABLE IF NOT EXISTS accounts (
    -- Normalised (lower-cased, trimmed) by the caller, so one person is one row.
    email        TEXT PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Touched on every successful sign-in. The only behavioural signal kept.
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The address a KYC submission belongs to.
--
-- Nullable on purpose: a verification started by a build that does not send it must still work, and
-- the column is only ever read for display. Nothing about approval depends on it.
ALTER TABLE kyc_verifications ADD COLUMN IF NOT EXISTS email TEXT;

-- Reviewers open the queue far more often than any other query here.
CREATE INDEX IF NOT EXISTS kyc_verifications_email_idx ON kyc_verifications (email);

-- The wallet this account owns.
--
-- Bound on first use rather than proved: the identifier is Poseidon(ownerSk, domain), and the app
-- cannot demonstrate ownership of it without a signature scheme the circuit does not expose yet. So
-- the first session to present a wallet claims it, and every later request from any account must
-- match. That does not stop a first-mover claiming someone else's identifier, but it does stop the
-- far more realistic case: a second party acting on a wallet already in use.
--
-- UNIQUE is the load-bearing part — it makes "this wallet belongs to one account" a database
-- guarantee rather than something the application has to remember to check.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pool_user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_pool_user_id_idx
    ON accounts (pool_user_id) WHERE pool_user_id IS NOT NULL;
