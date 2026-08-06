package chain

// Live assembly check against the deployed pool contract on testnet.
//
// Opt-in (PROVA_LIVE_TESTNET=1) because it needs the network and a funded account, and a unit-test
// suite must not fail when someone is offline.
//
// What it proves: a *deliberately invalid* proof must be rejected by the contract's Groth16 check,
// not by the host. Reaching error #2 means the whole envelope was accepted — contract id, function
// name, argument order, the symbol-keyed struct maps and their required key ordering, the i128
// amount, source-account auth and the simulated footprint. Everything except the proof itself, which
// cannot be produced here (the prover is a native Android build — see Docs/shielded-pool.md §9).

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stellar/go/clients/horizonclient"
	"github.com/stellar/go/network"
)

const (
	livePoolContract = "CCIKEXCOFG4PLRQEG4OD3QG76LGEWO6RZFX6WGBPRWEZZQ2SJ5UMJ2G5"
	liveHorizon      = "https://horizon-testnet.stellar.org"
	liveSoroban      = "https://soroban-testnet.stellar.org"
)

func liveAccount(t *testing.T) string {
	t.Helper()
	if addr := os.Getenv("PROVA_LIVE_ACCOUNT"); addr != "" {
		return addr
	}
	// The funded `prova-dev` testnet identity used for development.
	return "GBNYUIOGDP2OM27CPUUWDTUURKSOIEIIJCMOKLNAQQRSSSAG47EBUELR"
}

func TestShieldAssemblyIsAcceptedByTheDeployedContract(t *testing.T) {
	if os.Getenv("PROVA_LIVE_TESTNET") != "1" {
		t.Skip("set PROVA_LIVE_TESTNET=1 to run against live testnet")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	b := NewShieldBuilder(
		&horizonclient.Client{HorizonURL: liveHorizon},
		NewSorobanClient(liveSoroban),
		livePoolContract,
		network.TestNetworkPassphrase,
	)

	zero32 := strings.Repeat("00", fieldLen)
	_, err := b.Build(ctx, ShieldRequest{
		From:   liveAccount(t),
		Amount: 10_000_000, // 1 SRT
		Note: ShieldNote{
			Commitment: zero32,
			OwnerPk:    zero32,
			EpkX:       zero32,
			EpkY:       zero32,
			EncAmount:  zero32,
			EncRho:     zero32,
		},
		ProofA: strings.Repeat("00", proofALen),
		ProofB: strings.Repeat("00", proofBLen),
		ProofC: strings.Repeat("00", proofCLen),
	})

	if err == nil {
		t.Fatal("an all-zero proof was accepted — the contract is not verifying proofs")
	}

	// The call must fail *inside* proof verification, which is only reachable once every argument
	// has been decoded. An all-zero G1 is not a curve point, so the host traps in the pairing check
	// (Error(Crypto, InvalidInput)) rather than the contract returning #2 — either outcome means the
	// arguments were accepted. What must NOT appear is a decoding complaint, which is how a wrong
	// key order, byte width, argument order or address type would surface.
	got := err.Error()
	reachedVerification := strings.Contains(got, "bls12_381") ||
		strings.Contains(got, "Error(Contract")
	if !reachedVerification {
		t.Fatalf("envelope rejected before proof verification — assembly is wrong: %v", got)
	}
	for _, decodeFailure := range []string{
		"UnexpectedType", "MissingValue", "WrongNumberOfArgs", "InvalidAction", "UnexpectedSize",
	} {
		if strings.Contains(got, decodeFailure) {
			t.Fatalf("argument decoding failed (%s): %v", decodeFailure, got)
		}
	}
	t.Logf("arguments accepted; rejected in proof verification as expected")
}

// TestShieldArgsRejectsMalformedFields keeps the width checks honest without touching the network.
func TestShieldArgsRejectsMalformedFields(t *testing.T) {
	zero32 := strings.Repeat("00", fieldLen)
	good := ShieldRequest{
		From:   "GBNYUIOGDP2OM27CPUUWDTUURKSOIEIIJCMOKLNAQQRSSSAG47EBUELR",
		Amount: 1,
		Note: ShieldNote{
			Commitment: zero32, OwnerPk: zero32, EpkX: zero32,
			EpkY: zero32, EncAmount: zero32, EncRho: zero32,
		},
		ProofA: strings.Repeat("00", proofALen),
		ProofB: strings.Repeat("00", proofBLen),
		ProofC: strings.Repeat("00", proofCLen),
	}
	if _, err := shieldArgs(livePoolContract, good); err != nil {
		t.Fatalf("well-formed request rejected: %v", err)
	}

	for name, mutate := range map[string]func(*ShieldRequest){
		"short commitment": func(r *ShieldRequest) { r.Note.Commitment = "00" },
		"short proof A":    func(r *ShieldRequest) { r.ProofA = "00" },
		"non-hex field":    func(r *ShieldRequest) { r.Note.EncRho = strings.Repeat("zz", fieldLen) },
		"zero amount":      func(r *ShieldRequest) { r.Amount = 0 },
		"negative amount":  func(r *ShieldRequest) { r.Amount = -1 },
	} {
		bad := good
		mutate(&bad)
		if _, err := shieldArgs(livePoolContract, bad); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
