-- 0004_support: in-app support conversations between a user and the Prova team.
--
-- One thread per user, keyed by the same opaque `user_id` the KYC tables use — never an email, a
-- name or a phone number. A support thread is the one place a person will voluntarily type personal
-- details, so the *schema* deliberately gives them nowhere structured to land: there is a body and
-- nothing else, and the operator console shows the same opaque id it always has.
--
-- Message bodies are stored in the clear, unlike everything else in this system. That is a
-- deliberate, narrow exception: a support reply has to be readable by a human on the other end, so
-- end-to-end encryption would defeat the feature. Nothing about a transfer — amount, recipient,
-- note — is ever written here by the app.
--
-- Idempotent (IF NOT EXISTS), applied on boot like the earlier migrations.

CREATE TABLE IF NOT EXISTS support_threads (
    user_id      TEXT PRIMARY KEY,
    -- Denormalised so the operator inbox can sort and badge without touching every message.
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Unread by the team: incremented on a user message, cleared when the team replies.
    unread_count INT NOT NULL DEFAULT 0,
    -- open | closed. Closing is a filing action, not a lock — a new message reopens the thread.
    status       TEXT NOT NULL DEFAULT 'open',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The inbox is ordered by most recent activity, which is the only ordering it ever uses.
CREATE INDEX IF NOT EXISTS support_threads_recent_idx ON support_threads (last_message_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES support_threads (user_id) ON DELETE CASCADE,
    -- 'user' or 'team'. Not a person's name: the team is one operator today, and recording who
    -- typed a reply is a decision for when there is more than one of them.
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_messages_thread_idx ON support_messages (user_id, id);
