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
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
