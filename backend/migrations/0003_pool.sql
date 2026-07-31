-- 0003_pool: shielded-pool indexer state (Docs/shielded-pool.md §10.7).
--
-- The pool contract stores only a Merkle root — it cannot hash, so it cannot hold the tree (§10.1).
-- These tables are the off-chain mirror the wallet needs to spend: without a membership path there
-- is no spend proof, so this indexer is load-bearing for the product, not an analytics nicety.
--
-- PRIVACY: everything here is already public on-chain. Commitments and nullifiers are opaque hashes;
-- the encrypted payloads are ciphertext only this note's owner can open. No amounts, no identities,
-- no link between a sender and a recipient. Nothing recorded here weakens the pool's privacy, and
-- nothing here is secret — this is a cache of the chain, rebuildable from scratch at any time.
--
-- Idempotent (IF NOT EXISTS), applied on boot like 0001/0002.

-- Every commitment the contract has emitted, in the order it was queued.
--
-- `leaf_index` is assigned by the CONTRACT when a note is folded into the tree, and is the position
-- a membership proof is built against. It stays NULL while a note is only queued: a note is not
-- spendable until its fold lands, and a wallet that treated a queued note as spendable would build
-- a proof against a leaf that does not exist yet.
CREATE TABLE IF NOT EXISTS pool_notes (
    -- Position in the contract's queue (the `note` event's index). Monotonic, gapless, and the
    -- primary key because the contract folds strictly in queue order.
    queue_index  BIGINT PRIMARY KEY,
    -- The tree leaf, 32-byte hex. Never zero: zero is the empty-leaf value and the fold circuit
    -- rejects it in an active slot.
    commitment   TEXT NOT NULL UNIQUE,
    -- Position in the Merkle tree once folded; NULL while still queued.
    leaf_index   BIGINT UNIQUE,
    -- Encrypted note, as emitted. These are Groth16 public inputs bound by the spend proof, so a
    -- relayer cannot have corrupted them in flight (§10.5).
    epk_x        TEXT NOT NULL,
    epk_y        TEXT NOT NULL,
    enc_amount   TEXT NOT NULL,
    enc_rho      TEXT NOT NULL,
    -- Output slot (0 or 1), domain-separated into the decryption key. A wallet cannot decrypt
    -- without it.
    slot         SMALLINT NOT NULL,
    -- Where it came from, for scanning and debugging.
    ledger       BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wallets scan forward by queue_index; the folder reads the unfolded head in the same order.
CREATE INDEX IF NOT EXISTS pool_notes_unfolded_idx ON pool_notes (queue_index) WHERE leaf_index IS NULL;
CREATE INDEX IF NOT EXISTS pool_notes_leaf_idx ON pool_notes (leaf_index) WHERE leaf_index IS NOT NULL;

-- Roots the contract has published, newest last.
--
-- A spend proves membership against whatever root the wallet last saw, and the contract accepts any
-- of the last MerkleRootHistory (32). Keeping the history here lets the backend tell a wallet
-- whether a proof it is about to build is still in the window.
CREATE TABLE IF NOT EXISTS pool_roots (
    -- Number of leaves in the tree at this root; also the fold's start index. Monotonic.
    next_index   BIGINT PRIMARY KEY,
    root         TEXT NOT NULL,
    -- How many commitments this fold carried (1..=MerkleBatch).
    count        INT NOT NULL,
    ledger       BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Spent nullifiers, so a wallet can mark its own notes spent without trusting local state alone.
CREATE TABLE IF NOT EXISTS pool_nullifiers (
    nullifier    TEXT PRIMARY KEY,
    ledger       BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where the indexer has read up to.
--
-- Single row (id = TRUE). Persisted so a restart resumes instead of rescanning from genesis — and,
-- more importantly, so a restart cannot silently skip ledgers and lose notes.
CREATE TABLE IF NOT EXISTS pool_cursor (
    id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    -- Soroban getEvents pagination cursor; empty until the first successful poll.
    cursor       TEXT NOT NULL DEFAULT '',
    -- Highest ledger fully ingested.
    last_ledger  BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
