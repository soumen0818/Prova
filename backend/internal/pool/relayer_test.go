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
