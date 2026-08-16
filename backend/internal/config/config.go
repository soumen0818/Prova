// Package config loads runtime configuration from the environment.
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all backend runtime settings. Secrets come from the environment
// (see .env.example); never hardcode them.
type Config struct {
	AppEnv         string
	Port           string
	DatabaseURL    string
	RedisURL       string
	StellarNetwork string
	SorobanRPCURL  string
	HorizonURL     string

	// RunMode selects what this process runs, so the same image scales as separate roles:
	//   all      → HTTP API + embedded indexer (single-container / dev default)
	//   api      → HTTP API only (run N replicas behind a load balancer)
	//   indexer  → the on-chain indexer only (exactly one replica)
	RunMode string

	// TrustProxyHeaders controls whether X-Forwarded-For / X-Real-IP are believed when identifying a
	// caller for rate limiting.
	//
	// Default FALSE, deliberately. Trusting these unconditionally makes every per-IP limit
	// bypassable with a single header — the standard way IP rate limiting is defeated. Set it only
	// when the service genuinely sits behind a proxy you control.
	TrustProxyHeaders bool

	// DBSimpleProtocol disables prepared statements — required behind a transaction-mode pooler
	// such as Supabase's pooled endpoint. Direct/session connections leave this false.
	DBSimpleProtocol bool

	// Phase 2 — verifier contract + relayer.
	ContractID string // deployed Prova verifier contract id
	RelayerKey string // stellar CLI identity used to submit transactions
	StellarBin string // path to the `stellar` CLI

	// Phase 2 — anchor (SEP) integration.
	AnchorHomeDomain  string // e.g. testanchor.stellar.org (SEP-1 toml host)
	AnchorAsset       string // deposit asset code on the anchor (SDF testanchor: SRT)
	AnchorAssetIssuer string // issuer (G...) of the deposit asset; empty → discovered from the toml
	SEP10Seed         string // Stellar secret seed the backend uses for SEP-10 auth (dev)

	// DepositMode decouples "how money is added" from "how login works" (previously both keyed off
	// AUTH_MODE, so you couldn't have easy dev login AND the real on-chain deposit flow):
	//   "simulated" → the app credits a local testnet balance (fast dev loop, no chain).
	//   "anchor"    → real testnet rails: fund the account, add a trustline, read the on-chain
	//                 balance from Horizon. Still testnet — the asset has no real value.
	DepositMode string

	// Phase 4 — the shielded pool (Docs/shielded-pool.md). A SEPARATE contract from ContractID.
	//
	// Empty disables the /pool routes entirely. That is not a degraded feature: without the indexer
	// a wallet has no Merkle path and therefore cannot spend at all.
	PoolContractID string
	// PoolFoldKeyCache is where the fold proving key is cached. Generating it costs ~1.5 s and the
	// folder runs every few seconds, so this is a meaningful latency win; it is a pure cache, safe
	// to delete.
	PoolFoldKeyCache string
	// PoolSetupSeed must match the seed the contract's embedded verifying keys were generated with,
	// or every fold proof this backend produces will be rejected on-chain.
	PoolSetupSeed uint64
	// PoolFoldInterval is how often queued commitments are folded into the tree.
	//
	// This IS the "how long until my money is spendable" delay users feel, so shorter is better for
	// UX. The floor is proving time (~1.5 s) plus a ledger close (~5 s on testnet); below that, folds
	// simply queue behind each other.
	PoolFoldInterval time.Duration
	// IndexerLookback is how many ledgers back a *fresh* indexer scan starts from. It applies only
	// when there is no stored position; afterwards the indexer resumes from where it left off.
	//
	// This is the setting that decides which existing notes a new deployment can see, and getting it
	// wrong is quiet and expensive: notes older than the window are never indexed, so the tree stays
	// empty, /pool/path returns nothing, and wallets that still hold those notes locally show a
	// balance they cannot spend. The default (20,000 ≈ 27 hours on testnet's ~5 s ledgers) suits a
	// pool that has always been indexed; point a new backend at an existing pool and it needs to
	// reach back to the pool contract's deployment instead.
	IndexerLookback uint32

	// Phase 3 — KYC credential issuance (anchor side).
	ProverBin  string // path to the prova-prover CLI (signs credentials, matches the circuit)
	AnchorSeed string // hex Jubjub anchor secret seed; empty → the CLI's built-in dev key

	// KYC verification (Docs/kyc-verification.md). Credentials are only issued against an approved
	// verification record; the provider reports its verdict on an HMAC-authenticated webhook.
	KYCWebhookSecret string        // shared secret for X-Prova-Signature; empty → checks skipped (local dev only)
	KYCMockDelay     time.Duration // simulated provider latency for the Stage A mock provider
	// KYCManualReview routes every submission to a human reviewer instead of auto-approving.
	//
	// Until a licensed vendor is integrated, nothing in the pipeline actually inspects a document —
	// so auto-approving would tell a user they are "verified" on the strength of no check at all.
	// Escalating to the review queue is both the honest behaviour and the one that matches how a
	// real compliance desk works.
	KYCManualReview bool

	// ComplianceToken gates the manual KYC decision endpoint (POST /kyc/verifications/{id}/decide) —
	// without it, anyone who knows/guesses a userId could self-approve their own KYC. Required as
	// "Bearer <token>" once AppEnv is production; empty in dev/staging skips the check (local testing
	// only — never leave this unset in a real deployment).
	ComplianceToken string

	// SMTP — sending the sign-in code by email.
	//
	// Unset means nothing is sent: development falls back to the fixed DevOTP, and production
	// refuses to sign anyone in rather than accepting sign-ups whose codes go nowhere.
	//
	// For Gmail use an App Password (Security → 2-Step Verification → App passwords). The ordinary
	// account password has been refused since Google removed "less secure app access" in 2022.
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	SMTPPassword string
	SMTPFrom     string
	SMTPFromName string

	// AuthMode selects how one-time codes behave:
	//
	//   development — if SMTP is configured, a REAL random code is sent; otherwise DevOTP is
	//                 accepted so the flow works offline.
	//   production  — SMTP must be configured. Without it, sign-in is refused rather than
	//                 silently accepting a fixed code.
	AuthMode string
	DevOTP   string // the accepted code in development mode

	// Maintenance mode. Announced through /healthz so the app shows its maintenance screen from a
	// server signal rather than a hardcoded client state — flip it without shipping a release.
	MaintenanceMode    bool
	MaintenanceMessage string // user-facing explanation
	MaintenanceUntil   string // optional ISO-8601 estimate of when service returns
}

// Load reads config from the environment with sensible testnet defaults.
func Load() Config {
	return Config{
		AppEnv:         getenv("APP_ENV", "development"),
		Port:           getenv("PORT", "8080"),
		DatabaseURL:    getenv("DATABASE_URL", "postgres://prova:prova@localhost:5432/prova?sslmode=disable"),
		RedisURL:       getenv("REDIS_URL", "redis://localhost:6379/0"),
		StellarNetwork: getenv("STELLAR_NETWORK", "testnet"),
		SorobanRPCURL:  getenv("SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org"),
		HorizonURL:     getenv("HORIZON_URL", "https://horizon-testnet.stellar.org"),

		TrustProxyHeaders: getbool("TRUST_PROXY_HEADERS", false),

		RunMode:          getenv("RUN_MODE", "all"),
		DBSimpleProtocol: getbool("DB_SIMPLE_PROTOCOL", false),

		ContractID: getenv("CONTRACT_ID", "CAM5FO22PLIINNETME2CXFPS2WL7WCYOESYTLNYPQMWVKWDADWD4BTJC"),
		RelayerKey: getenv("RELAYER_KEY", "prova-test"),
		StellarBin: getenv("STELLAR_BIN", "stellar"),

		AnchorHomeDomain:  getenv("ANCHOR_HOME_DOMAIN", "testanchor.stellar.org"),
		AnchorAsset:       getenv("ANCHOR_ASSET", "SRT"),
		AnchorAssetIssuer: getenv("ANCHOR_ASSET_ISSUER", ""),
		SEP10Seed:         getenv("SEP10_SEED", ""), // empty → an ephemeral key is generated
		DepositMode:       getenv("DEPOSIT_MODE", "simulated"),

		PoolContractID:   getenv("POOL_CONTRACT_ID", ""),
		PoolFoldKeyCache: getenv("POOL_FOLD_KEY_CACHE", ""),
		PoolSetupSeed:    getuint("POOL_SETUP_SEED", 42),
		PoolFoldInterval: getdur("POOL_FOLD_INTERVAL_SECONDS", 8*time.Second),
		IndexerLookback:  getu32("INDEXER_LOOKBACK_LEDGERS", 20_000),

		ProverBin:  getenv("PROVER_BIN", "prova-prover"),
		AnchorSeed: getenv("ANCHOR_SEED", ""), // empty → the CLI's built-in dev anchor key

		KYCWebhookSecret: getenv("KYC_WEBHOOK_SECRET", ""), // empty → signature check skipped (dev)
		KYCMockDelay:     getdur("KYC_MOCK_DELAY_SECONDS", 4*time.Second),
		KYCManualReview:  getbool("KYC_MANUAL_REVIEW", true),
		ComplianceToken:  getenv("COMPLIANCE_TOKEN", ""),

		SMTPHost:     getenv("SMTP_HOST", ""),
		SMTPPort:     int(getuint("SMTP_PORT", 587)),
		SMTPUsername: getenv("SMTP_USERNAME", ""),
		SMTPPassword: getenv("SMTP_PASSWORD", ""),
		SMTPFrom:     getenv("SMTP_FROM", ""),
		SMTPFromName: getenv("SMTP_FROM_NAME", "Prova"),

		AuthMode: getenv("AUTH_MODE", "development"),
		DevOTP:   getenv("DEV_OTP", "000000"),

		MaintenanceMode: getbool("MAINTENANCE_MODE", false),
		MaintenanceMessage: getenv("MAINTENANCE_MESSAGE",
			"We're carrying out scheduled maintenance. Your funds and account are safe."),
		MaintenanceUntil: getenv("MAINTENANCE_UNTIL", ""),
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// getdur reads an integer number of seconds from the environment.
func getdur(key string, fallback time.Duration) time.Duration {
	if secs, err := strconv.Atoi(os.Getenv(key)); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	return fallback
}

// getu32 reads a non-negative ledger count from the environment. Values that do not fit in a uint32
// fall back rather than wrapping — a lookback that silently became a small number would resume the
// exact bug this setting exists to fix.
func getu32(key string, fallback uint32) uint32 {
	if n, err := strconv.ParseUint(os.Getenv(key), 10, 32); err == nil && n > 0 {
		return uint32(n)
	}
	return fallback
}

func getbool(key string, fallback bool) bool {
	switch strings.ToLower(os.Getenv(key)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

// RunsAPI reports whether this process should serve HTTP.
func (c Config) RunsAPI() bool {
	return c.RunMode == "all" || c.RunMode == "api"
}

// RunsIndexer reports whether this process should run the on-chain indexer.
func (c Config) RunsIndexer() bool {
	return c.RunMode == "all" || c.RunMode == "indexer"
}

// getuint reads an unsigned integer env var, falling back to `def` when unset or unparseable.
func getuint(key string, def uint64) uint64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}
