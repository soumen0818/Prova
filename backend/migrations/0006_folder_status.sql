-- What the folder is doing, visible without a shell.
--
-- The folder runs in the indexer container and the API runs in another, so an in-memory field is
-- invisible to /pool/status — the one place anyone actually looks. Twice now a stuck deposit has
-- taken hours to diagnose because the only evidence was `docker logs` on a box behind a security
-- group, and the queue depth alone cannot distinguish "still working" from "failing every 8 seconds
-- for the same reason".
--
-- One row, rewritten in place. This is a status light, not a history.
CREATE TABLE IF NOT EXISTS pool_folder_status (
    id              BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    -- Empty when the last attempt succeeded. Truncated by the writer: this is surfaced publicly, so
    -- it must stay a short reason rather than a stack trace.
    last_error      TEXT NOT NULL DEFAULT '',
    -- How many attempts have failed in a row. Distinguishes a blip from a stall.
    consecutive_failures INT NOT NULL DEFAULT 0
);
