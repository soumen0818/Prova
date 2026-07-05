// Package config loads runtime configuration from the environment.
package config

import "os"

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

	// Phase 2 — verifier contract + relayer.
	ContractID string // deployed Prova verifier contract id
	RelayerKey string // stellar CLI identity used to submit transactions
	StellarBin string // path to the `stellar` CLI

	// Phase 2 — anchor (SEP) integration.
	AnchorHomeDomain string // e.g. testanchor.stellar.org (SEP-1 toml host)
	AnchorAsset      string // deposit asset code on the anchor (SDF testanchor: SRT)
	SEP10Seed        string // Stellar secret seed the backend uses for SEP-10 auth (dev)

	// Phase 3 — KYC credential issuance (anchor side).
	ProverBin  string // path to the prova-prover CLI (signs credentials, matches the circuit)
	AnchorSeed string // hex Jubjub anchor secret seed; empty → the CLI's built-in dev key
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

		ContractID: getenv("CONTRACT_ID", "CAM5FO22PLIINNETME2CXFPS2WL7WCYOESYTLNYPQMWVKWDADWD4BTJC"),
		RelayerKey: getenv("RELAYER_KEY", "prova-test"),
		StellarBin: getenv("STELLAR_BIN", "stellar"),

		AnchorHomeDomain: getenv("ANCHOR_HOME_DOMAIN", "testanchor.stellar.org"),
		AnchorAsset:      getenv("ANCHOR_ASSET", "SRT"),
		SEP10Seed:        getenv("SEP10_SEED", ""), // empty → an ephemeral key is generated

		ProverBin:  getenv("PROVER_BIN", "prova-prover"),
		AnchorSeed: getenv("ANCHOR_SEED", ""), // empty → the CLI's built-in dev anchor key
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
