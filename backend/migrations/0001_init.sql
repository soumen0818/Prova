-- 0001_init: transfer records. Stores NO amounts — only commitment/nullifier references, status,
-- and timestamps. The nullifier is UNIQUE, giving DB-level anti-replay/idempotency for the whole
-- transfer lifecycle.
--
-- Portable to any Postgres (self-hosted container or a managed provider such as Supabase). Applied
-- automatically on boot by the backend, and safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS transfers (
    id          UUID PRIMARY KEY,
    status      TEXT NOT NULL,
    commitment  TEXT NOT NULL,
    nullifier   TEXT NOT NULL UNIQUE,
    tx_hash     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transfers_commitment_idx ON transfers (commitment);
