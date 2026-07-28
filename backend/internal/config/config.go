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

	// Phase 3 — KYC credential issuance (anchor side).
	ProverBin  string // path to the prova-prover CLI (signs credentials, matches the circuit)
	AnchorSeed string // hex Jubjub anchor secret seed; empty → the CLI's built-in dev key

	// KYC verification (Docs/kyc-verification.md). Credentials are only issued against an approved
	// verification record; the provider reports its verdict on an HMAC-authenticated webhook.
	KYCWebhookSecret string        // shared secret for X-Prova-Signature; empty → checks skipped (local dev only)
	KYCMockDelay     time.Duration // simulated provider latency for the Stage A mock provider

	// Phone-login OTP. "development" bypasses SMS with a fixed code; "production" wires a real
	// SMS provider (Twilio, not yet configured — returns 501). Flip via AUTH_MODE.
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

		ProverBin:  getenv("PROVER_BIN", "prova-prover"),
		AnchorSeed: getenv("ANCHOR_SEED", ""), // empty → the CLI's built-in dev anchor key

		KYCWebhookSecret: getenv("KYC_WEBHOOK_SECRET", ""), // empty → signature check skipped (dev)
		KYCMockDelay:     getdur("KYC_MOCK_DELAY_SECONDS", 4*time.Second),

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
