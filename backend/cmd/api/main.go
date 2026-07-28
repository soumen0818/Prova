// Command api is the Prova backend HTTP service.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/stellar/go/keypair"

	"github.com/prova/backend/internal/anchor"
	"github.com/prova/backend/internal/chain"
	"github.com/prova/backend/internal/config"
	"github.com/prova/backend/internal/indexer"
	"github.com/prova/backend/internal/kyc"
	"github.com/prova/backend/internal/server"
	"github.com/prova/backend/internal/store"
	"github.com/prova/backend/internal/transfers"
	"github.com/prova/shared/schema"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg := config.Load()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	deps, idx := buildDeps(ctx, logger, cfg)

	// Indexer role — reconcile on-chain events into history. Run exactly one of these across the
	// fleet (RUN_MODE=indexer), so scaling the API doesn't spawn duplicate indexers.
	if cfg.RunsIndexer() {
		if idx != nil {
			go idx.Run(ctx)
			logger.Info("indexer started", "rpc", cfg.SorobanRPCURL)
		} else {
			logger.Warn("indexer role selected but store unavailable — indexer not started")
		}
	}

	// API role — HTTP server. Scale these horizontally (RUN_MODE=api) behind a load balancer.
	var srv *http.Server
	if cfg.RunsAPI() {
		srv = &http.Server{
			Addr:         ":" + cfg.Port,
			Handler:      server.New(logger, cfg, deps),
			ReadTimeout:  15 * time.Second,
			WriteTimeout: 60 * time.Second, // anchor round-trips can be slow
			IdleTimeout:  60 * time.Second,
		}
		go func() {
			logger.Info("backend listening", "addr", srv.Addr, "env", cfg.AppEnv, "mode", cfg.RunMode, "contract", cfg.ContractID)
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Error("server error", "err", err)
				os.Exit(1)
			}
		}()
	}

	if srv == nil && !cfg.RunsIndexer() {
		logger.Error("nothing to run — set RUN_MODE to all|api|indexer", "mode", cfg.RunMode)
		os.Exit(1)
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	cancel() // stop the indexer loop

	if srv != nil {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("graceful shutdown failed", "err", err)
		}
	}
	logger.Info("backend stopped")
}

// buildDeps wires the Phase 2 services. Infra that is unavailable degrades gracefully: the
// corresponding routes return 503 instead of crashing the process.
func buildDeps(ctx context.Context, logger *slog.Logger, cfg config.Config) (server.Deps, *indexer.Indexer) {
	var deps server.Deps
	var idx *indexer.Indexer

	// Postgres store + transfer relay. `pg` is non-nil once migrations succeed, so the KYC
	// verification state machine (which needs persistence) can be wired below.
	var pg *store.Store
	st, err := store.New(ctx, cfg.DatabaseURL, cfg.DBSimpleProtocol)
	if err != nil {
		logger.Warn("postgres unavailable — /transfers disabled", "err", err)
	} else if err := st.Migrate(ctx); err != nil {
		logger.Error("migration failed — /transfers disabled", "err", err)
	} else {
		pg = st
		rdb := connectRedis(logger, cfg.RedisURL)
		submitter := chain.CLISubmitter{
			Bin:        cfg.StellarBin,
			ContractID: cfg.ContractID,
			Source:     cfg.RelayerKey,
			Network:    cfg.StellarNetwork,
		}
		deps.Transfers = transfers.New(st, submitter, rdb, logger)
		logger.Info("transfer relay ready", "contract", cfg.ContractID)

		// Indexer is constructed here (needs the store); main starts it only in the indexer role.
		events := chain.NewEventsClient(cfg.SorobanRPCURL, cfg.ContractID)
		idx = indexer.New(events, st, logger, 15*time.Second, 20_000)
	}

	// Anchor (SEP-10 / SEP-24) with a dev key.
	kp, err := sep10Key(cfg.SEP10Seed)
	if err != nil {
		logger.Warn("sep10 key invalid — anchor routes disabled", "err", err)
	} else {
		deps.Anchor = anchor.New(cfg.AnchorHomeDomain)
		deps.SEP10Key = kp
		logger.Info("anchor client ready", "home_domain", cfg.AnchorHomeDomain, "account", kp.Address())
	}

	// On-chain wallet (real testnet deposit flow): funding, trustlines, balance reads from Horizon.
	deps.Wallet = chain.NewWallet(cfg.HorizonURL, cfg.StellarNetwork)
	logger.Info("on-chain wallet ready", "horizon", cfg.HorizonURL, "deposit_mode", cfg.DepositMode)

	// KYC credential issuer (anchor side) — signs via the prover CLI.
	issuer := kyc.CLIIssuer{ProverBin: cfg.ProverBin, AnchorSeed: cfg.AnchorSeed}
	if pk, perr := issuer.AnchorPublicKey(ctx); perr != nil {
		logger.Warn("prover CLI unavailable — /kyc routes disabled", "err", perr, "bin", cfg.ProverBin)
	} else {
		deps.KYC = issuer
		logger.Info("kyc issuer ready", "anchor_pk_x", pk.X)

		// KYC verification state machine. Needs persistence: credentials are issued only against a
		// stored `approved` record (Docs/kyc-verification.md §5), so without Postgres we leave the
		// routes disabled rather than fall back to issuing unconditionally.
		if pg == nil {
			logger.Warn("postgres unavailable — /kyc/verifications disabled (credentials cannot be gated)")
		} else {
			provider := kyc.NewMockProvider(cfg.KYCMockDelay)
			svc := kyc.NewService(pg, provider, issuer, logger)
			// The mock reports its simulated verdict straight back into the state machine, standing
			// in for a real provider's webhook.
			provider.OnVerdict = func(c context.Context, v kyc.Verdict) {
				if aerr := svc.ApplyVerdict(c, v); aerr != nil {
					logger.Error("mock verdict failed", "err", aerr)
				}
			}
			deps.Verification = svc
			deps.VerificationProvider = provider
			logger.Info("kyc verification ready", "provider", provider.Name(),
				"credential_ttl_days", schema.CredentialTTLDays)
		}
	}

	return deps, idx
}

func connectRedis(logger *slog.Logger, redisURL string) *redis.Client {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		logger.Warn("redis url invalid — idempotency lock disabled", "err", err)
		return nil
	}
	rdb := redis.NewClient(opts)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		logger.Warn("redis unavailable — idempotency lock disabled", "err", err)
		return nil
	}
	return rdb
}

func sep10Key(seed string) (*keypair.Full, error) {
	if seed == "" {
		return keypair.Random()
	}
	return keypair.ParseFull(seed)
}
