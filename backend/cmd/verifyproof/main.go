// Command verifyproof is a Phase 1 dev-only tool: it submits a proof blob to the deployed Prova
// verifier contract and reports accept/reject. Not the real flow — used for testing.
//
// It reads a Soroban-encoded proof blob (as written by the prova-prover CLI):
//
//	A(96) | B(192) | C(96) | commitment(32) | nullifier(32)  = 448 bytes
//
// and invokes the contract's `verify` via the `stellar` CLI.
//
// Usage:
//
//	verifyproof --proof PATH --contract CID [--network testnet] [--source prova-test]
package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/prova/shared/schema"
)

func main() {
	proofPath := flag.String("proof", "", "path to the Soroban-encoded proof blob (448 bytes)")
	contract := flag.String("contract", "", "verifier contract id")
	network := flag.String("network", "testnet", "stellar network")
	source := flag.String("source", "prova-test", "stellar source identity")
	stellarBin := flag.String("stellar", "stellar", "path to the stellar CLI")
	flag.Parse()

	if *proofPath == "" || *contract == "" {
		fmt.Fprintln(os.Stderr, "error: --proof and --contract are required")
		flag.Usage()
		os.Exit(2)
	}

	blob, err := os.ReadFile(*proofPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: reading proof: %v\n", err)
		os.Exit(1)
	}

	// Slice the blob using the frozen shared byte lengths.
	want := 2*schema.G1Len + schema.G2Len + 2*schema.ScalarLen
	if len(blob) != want {
		fmt.Fprintf(os.Stderr, "error: proof blob is %d bytes, expected %d\n", len(blob), want)
		os.Exit(1)
	}
	var off int
	take := func(n int) string {
		s := hex.EncodeToString(blob[off : off+n])
		off += n
		return s
	}
	a := take(schema.G1Len)
	b := take(schema.G2Len)
	c := take(schema.G1Len)
	commitment := take(schema.ScalarLen)
	nullifier := take(schema.ScalarLen)

	args := []string{
		"contract", "invoke",
		"--id", *contract,
		"--source", *source,
		"--network", *network,
		"--",
		"verify",
		"--proof_a", a,
		"--proof_b", b,
		"--proof_c", c,
		"--commitment", commitment,
		"--nullifier", nullifier,
	}
	cmd := exec.Command(*stellarBin, args...)
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: stellar invoke failed: %v\n%s\n", err, text)
		os.Exit(1)
	}

	// The CLI prints the boolean result on the last non-empty line.
	accepted := lastLine(text) == "true"
	if accepted {
		fmt.Printf("ACCEPT — proof verified on %s (%s)\n", *network, *contract)
		os.Exit(0)
	}
	fmt.Printf("REJECT — proof did not verify on %s (%s)\n", *network, *contract)
	os.Exit(1)
}

func lastLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if t := strings.TrimSpace(lines[i]); t != "" {
			return t
		}
	}
	return ""
}
