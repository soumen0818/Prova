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
	"github.com/prova/backend/internal/mailer"
	poolpkg "github.com/prova/backend/internal/pool"
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
	deps, idx, poolIdx, folder := buildDeps(ctx, logger, cfg)

	// Indexer role — reconcile on-chain events into history. Run exactly one of these across the
	// fleet (RUN_MODE=indexer), so scaling the API doesn't spawn duplicate indexers.
	if cfg.RunsIndexer() {
		if idx != nil {
			go idx.Run(ctx)
			logger.Info("indexer started", "rpc", cfg.SorobanRPCURL)
		} else {
			logger.Warn("indexer role selected but store unavailable — indexer not started")
		}
		// The pool indexer runs alongside it. Exactly one replica: leaf indices are assigned in
		// queue order, and two writers racing on the same range would corrupt that ordering.
		if poolIdx != nil {
			go poolIdx.Run(ctx)
			logger.Info("pool indexer started", "contract", cfg.PoolContractID)
		}
		// Exactly one folder too. A second would race for the same queue head: the loser's proof is
		// rejected because the root moved, so nothing breaks — but each wasted race costs a proof.
		if folder != nil {
			go folder.Run(ctx)
			logger.Info("pool folder started", "interval", cfg.PoolFoldInterval)
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
func buildDeps(ctx context.Context, logger *slog.Logger, cfg config.Config) (server.Deps, *indexer.Indexer, *poolpkg.Indexer, *poolpkg.Folder) {
	var deps server.Deps
	var idx *indexer.Indexer
	var poolIdx *poolpkg.Indexer
	var folder *poolpkg.Folder

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
		// Support conversations talk to Postgres directly — an append and a list, with no domain
		// logic that would justify a service layer.
		deps.Store = st
		rdb := connectRedis(logger, cfg.RedisURL)
		// Backs the rate limiter too, so limits hold across replicas rather than per-instance.
		deps.Redis = rdb
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

		// Shielded pool. Without POOL_CONTRACT_ID there is no pool to index, and the /pool routes
		// answer 503 — which is honest: a wallet cannot build a spend proof without these.
		if cfg.PoolContractID == "" {
			logger.Warn("POOL_CONTRACT_ID unset — /pool routes disabled (wallets cannot spend)")
		} else {
			prover := poolpkg.Prover{
				Bin:          cfg.ProverBin,
				FoldKeyCache: cfg.PoolFoldKeyCache,
				Seed:         cfg.PoolSetupSeed,
			}
			// Relaying keeps the user's Stellar account off their spend. Only transact/unshield are
			// relayed: shield needs the user's own authorisation to move their tokens, and it is
			// public by design anyway, so relaying it would buy no privacy.
			relayer := &poolpkg.Relayer{
				Bin:        cfg.StellarBin,
				ContractID: cfg.PoolContractID,
				Source:     cfg.RelayerKey,
				Network:    cfg.StellarNetwork,
			}
			deps.Pool = poolpkg.NewService(st, prover, relayer)
			poolEvents := chain.NewPoolEventsClient(cfg.SorobanRPCURL, cfg.PoolContractID)
			poolIdx = poolpkg.NewIndexer(poolEvents, st, logger, 5*time.Second, 20_000)

			// The folder is what makes queued notes spendable. It is trusted with nothing — the
			// proof enforces correctness and the contract supplies the leaves from its own queue —
			// so running it here is an availability decision, not a trust one.
			folder = poolpkg.NewFolder(st, prover, poolpkg.CLIRootSubmitter{
				Bin:        cfg.StellarBin,
				ContractID: cfg.PoolContractID,
				Source:     cfg.RelayerKey,
				Network:    cfg.StellarNetwork,
			}, logger, cfg.PoolFoldInterval)

			logger.Info("shielded pool ready",
				"contract", cfg.PoolContractID, "fold_interval", cfg.PoolFoldInterval)
		}
	}

	// Email sender for sign-in codes. Unconfigured leaves it nil, and the server substitutes a Noop
	// that reports itself unavailable — so a missing SMTP setup surfaces as a clear message rather
	// than sign-ups whose codes go nowhere.
	if cfg.SMTPHost != "" && cfg.SMTPUsername != "" && cfg.SMTPPassword != "" {
		deps.Mailer = mailer.SMTP{
			Host:     cfg.SMTPHost,
			Port:     cfg.SMTPPort,
			Username: cfg.SMTPUsername,
			Password: cfg.SMTPPassword,
			From:     cfg.SMTPFrom,
			FromName: cfg.SMTPFromName,
		}
		logger.Info("email sign-in ready", "smtp_host", cfg.SMTPHost, "from", cfg.SMTPUsername)
	} else if cfg.AuthMode == "production" {
		logger.Error("SMTP is not configured and AUTH_MODE=production — sign-in will be refused")
	} else {
		logger.Warn("SMTP not configured — sign-in uses the fixed dev code", "dev_otp", cfg.DevOTP)
	}

	// COMPLIANCE_TOKEN gates POST /kyc/verifications/{id}/decide — without it, anyone who knows a
	// userId can self-approve their own KYC. Only ever acceptable to skip in local dev.
	if cfg.ComplianceToken == "" {
		if cfg.AppEnv == "production" {
			logger.Error("COMPLIANCE_TOKEN is not set and APP_ENV=production — " +
				"the manual KYC decision endpoint is UNAUTHENTICATED; set COMPLIANCE_TOKEN before deploying")
		} else {
			logger.Warn("COMPLIANCE_TOKEN not set — the manual KYC decision endpoint has no auth (dev only)")
		}
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

	// Shield builder: assembles `shield` invocations the *user* signs. Needs the pool contract, so
	// it stays nil (routes 503) when the pool is not deployed for this environment.
	if cfg.PoolContractID != "" {
		deps.Shielder = chain.NewShieldBuilderFor(
			cfg.HorizonURL, cfg.SorobanRPCURL, cfg.PoolContractID, cfg.StellarNetwork,
		)
		logger.Info("shield builder ready", "contract", cfg.PoolContractID, "rpc", cfg.SorobanRPCURL)
	} else {
		logger.Warn("POOL_CONTRACT_ID unset — /pool/shield routes disabled")
	}

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
			if cfg.KYCManualReview {
				// Every submission lands in the human queue. See config.KYCManualReview.
				provider.ForceDecision = kyc.DecisionReview
			}
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

	return deps, idx, poolIdx, folder
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
