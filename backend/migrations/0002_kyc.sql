-- 0002_kyc: KYC verification records + an append-only decision audit log.
--
-- PII-FREE BY DESIGN (Docs/kyc-verification.md §3): these tables hold no name, date of birth,
-- document number or image. The only user identifier is `user_id` = Poseidon(secret, domain), an
-- opaque hash that reveals nothing and cannot be linked to on-chain commitments. Identity data is
-- held by the licensed anchor / verification vendor — never here.
--
-- Idempotent (IF NOT EXISTS), applied on boot like 0001.

CREATE TABLE IF NOT EXISTS kyc_verifications (
    id           UUID PRIMARY KEY,
    -- Opaque wallet identifier. One active verification per user (latest submission wins).
    user_id      TEXT NOT NULL UNIQUE,
    status       TEXT NOT NULL,
    tier         INT  NOT NULL DEFAULT 0,
    -- Unix seconds; the credential validity window granted on approval (0 until approved).
    expiry       BIGINT NOT NULL DEFAULT 0,
    -- Machine-readable rejection/review reason (see schema.Reason*).
    reason_code  TEXT NOT NULL DEFAULT '',
    -- The verification provider's reference for this submission (vendor id; mock ref in Stage A).
    provider_ref TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kyc_verifications_status_idx ON kyc_verifications (status);
-- Webhook lookups arrive keyed by the provider's reference.
CREATE INDEX IF NOT EXISTS kyc_verifications_provider_ref_idx ON kyc_verifications (provider_ref);

-- Append-only audit trail: regulators require proof of WHY each decision was made, and by whom.
-- Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS kyc_audit_log (
    id              BIGSERIAL PRIMARY KEY,
    verification_id UUID NOT NULL,
    user_id         TEXT NOT NULL,
    -- What happened: submitted | verdict | decided | issued | renewed | expired | revoked.
    event           TEXT NOT NULL,
    from_status     TEXT NOT NULL DEFAULT '',
    to_status       TEXT NOT NULL DEFAULT '',
    tier            INT  NOT NULL DEFAULT 0,
    reason_code     TEXT NOT NULL DEFAULT '',
    -- Who decided: "provider:<name>" for automated, or a compliance officer id for manual review.
    actor           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kyc_audit_log_verification_idx ON kyc_audit_log (verification_id, created_at);
CREATE INDEX IF NOT EXISTS kyc_audit_log_user_idx ON kyc_audit_log (user_id, created_at);
