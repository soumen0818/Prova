package pool

import (
	"context"
	"strings"
	"testing"
)

// The relayer's job is to submit without being able to alter anything. These cover the parts that
// are pure logic — blob framing and argument construction — since everything else needs a chain.

func TestSplitProofChecksLength(t *testing.T) {
	a, b, c, err := splitProof(strings.Repeat("ab", 384))
	if err != nil {
		t.Fatalf("a 768-char blob must split: %v", err)
	}
	// A(96) ‖ B(192) ‖ C(96) bytes → 192 ‖ 384 ‖ 192 hex chars.
	if len(a) != 192 || len(b) != 384 || len(c) != 192 {
		t.Errorf("split sizes: a=%d b=%d c=%d, want 192/384/192", len(a), len(b), len(c))
	}
	if a+b+c != strings.Repeat("ab", 384) {
		t.Error("the three parts must reassemble into the original blob")
	}

	// A wrong length would otherwise produce a malformed invocation whose failure looks exactly like
	// a rejected proof, sending anyone debugging it down the wrong path.
	for _, bad := range []string{"", "abc", strings.Repeat("ab", 383), strings.Repeat("ab", 385)} {
		if _, _, _, err := splitProof(bad); err == nil {
			t.Errorf("blob of %d chars must be rejected", len(bad))
		}
	}
}

func TestUnshieldValidatesItsArguments(t *testing.T) {
	r := Relayer{Bin: "stellar", ContractID: "C...", Source: "src", Network: "testnet"}
	valid := strings.Repeat("ab", 384)
	ctx := context.Background()

	// A non-positive amount is a client bug; catching it here avoids burning a submission on a
	// transaction the contract will reject anyway (Error #8 InvalidAmount).
	if _, err := r.Unshield(ctx, SpendRequest{ProofHex: valid, Amount: 0, Destination: "G..."}); err == nil {
		t.Error("a zero amount must be rejected")
	}
	if _, err := r.Unshield(ctx, SpendRequest{ProofHex: valid, Amount: -5, Destination: "G..."}); err == nil {
		t.Error("a negative amount must be rejected")
	}
	if _, err := r.Unshield(ctx, SpendRequest{ProofHex: valid, Amount: 10}); err == nil {
		t.Error("a missing destination must be rejected")
	}
}

// The encrypted payloads are proof-bound public inputs, so the JSON the relayer builds must carry
// every field: dropping one would make the contract's input vector disagree with the proof and every
// spend would fail.
func TestSpendOutputsJSONCarriesEveryProofBoundField(t *testing.T) {
	o := SpendOutputs{
		C1: "c1", C2: "c2",
		EpkX: "ex", EpkY: "ey",
		Enc1Amount: "a1", Enc1Rho: "r1",
		Enc2Amount: "a2", Enc2Rho: "r2",
	}
	js := o.json()
	for _, want := range []string{
		`"c1":"c1"`, `"c2":"c2"`,
		`"epk_x":"ex"`, `"epk_y":"ey"`,
		`"enc1_amount":"a1"`, `"enc1_rho":"r1"`,
		`"enc2_amount":"a2"`, `"enc2_rho":"r2"`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("outputs JSON is missing %s: %s", want, js)
		}
	}
}

// A proof the host rejects must be reported as a rejected proof, not as an unknown failure.
//
// Verified against the live contract: an invalid proof traps in the host's BLS pairing check with
// Error(Crypto, InvalidInput) — the contract's own #4 never runs. Before this mapping existed the
// whole class fell through to the catch-all and reached the user as "could not relay the spend".
func TestHostLevelProofFailuresAreRejections(t *testing.T) {
	for name, text := range map[string]string{
		"host crypto error": "error: transaction simulation failed: HostError: Error(Crypto, InvalidInput)",
		"point not on curve": "[Diagnostic Event] topics:[error, Error(Crypto, InvalidInput)], " +
			`data:"bls12-381 G1: point not on curve"`,
		"pairing check trap": `data:"escalating error to VM trap from failed host function call: ` +
			`bls12_381_multi_pairing_check"`,
	} {
		t.Run(name, func(t *testing.T) {
			if !isRejectedProofOutput(text) {
				t.Errorf("output was not classified as a rejected proof:\n%s", text)
			}
		})
	}
}

// A genuine contract rejection must still map, and unrelated failures must NOT be mislabelled as
// proof problems — that would send someone debugging in the wrong direction.
func TestOnlyProofFailuresAreCalledProofFailures(t *testing.T) {
	if !isRejectedProofOutput("Error(Contract, #4)") {
		t.Error("contract #4 should still be a rejected proof")
	}
	for _, unrelated := range []string{
		"exit status 127: libdbus-1.so.3: cannot open shared object file",
		"error: connection refused",
		"Error(Contract, #3)",
	} {
		if isRejectedProofOutput(unrelated) {
			t.Errorf("unrelated failure mislabelled as a proof rejection: %q", unrelated)
		}
	}
}

// The contract function must be on the command line, immediately after the `--` separator.
//
// It once was not: `fn` was accepted and used only when formatting an error, so every invocation ran
// `... --send=yes -- --proof {...}` with no subcommand. The CLI replied with usage text and exit
// status 2, which matched no contract-error case and reached users as "could not relay the spend".
// Verified against the live contract: without the subcommand the CLI answers "unexpected argument
// '--proof' found"; with it, the call reaches the contract.
func TestInvokeArgsCarryTheContractFunction(t *testing.T) {
	r := Relayer{Bin: "stellar", ContractID: "CTEST", Source: "SSECRET", Network: "testnet"}
	args := invokeArgs(r, "transact", "--proof", "{}", "--root", "aa")

	sep := -1
	for i, a := range args {
		if a == "--" {
			sep = i
			break
		}
	}
	if sep == -1 {
		t.Fatalf("no `--` separator in %v", args)
	}
	if sep+1 >= len(args) {
		t.Fatalf("nothing follows `--` — the CLI would print usage: %v", args)
	}
	if got := args[sep+1]; got != "transact" {
		t.Errorf("first argument after `--` = %q, want the contract function %q", got, "transact")
	}
	// And the call's own arguments must follow it, not replace it.
	if args[sep+2] != "--proof" {
		t.Errorf("call arguments do not follow the function name: %v", args[sep:])
	}
}
