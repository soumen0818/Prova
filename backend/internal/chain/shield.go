package chain

// Building the `shield` invocation — money moving INTO the shielded pool.
//
// Shield is the one pool operation the relayer cannot perform on a user's behalf. The contract runs
// `from.require_auth()` and then `token_client.transfer(&from, …)`, so the tokens leave the *user's*
// account and only the user can authorise that. Having the backend hold the funds instead would
// make it a custodian, which is exactly the trust Prova claims not to need.
//
// So shield follows the same pattern as the trustline (Docs/deposit-flow.md): the backend builds and
// simulates, the phone signs the 32-byte transaction hash, the backend attaches the signature and
// submits. The user's secret never leaves the device, and no Stellar SDK is needed on the phone.
//
// This works because Soroban accepts **source-account authorisation**: when the address calling
// `require_auth()` is the transaction's source account, the transaction signature itself satisfies
// it. No separate SorobanAuthorizationEntry has to be signed — which is what makes hash-signing
// sufficient here.

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/stellar/go/clients/horizonclient"
	"github.com/stellar/go/network"
	"github.com/stellar/go/strkey"
	"github.com/stellar/go/txnbuild"
	"github.com/stellar/go/xdr"
)

// Byte widths the contract's types demand. A mismatch is rejected by the host, so they are checked
// here where the error can name the field.
const (
	fieldLen  = 32  // BytesN<32>
	proofALen = 96  // BytesN<96> — G1
	proofBLen = 192 // BytesN<192> — G2
	proofCLen = 96  // BytesN<96> — G1
)

// ErrShieldRejected means simulation says the call would revert on-chain — most often an invalid
// proof (contract error #2), since the proof is verified before the token moves. It is a permanent
// failure for this request, so callers must not retry it unchanged.
var ErrShieldRejected = errors.New("shield rejected by the contract")

// ErrShieldUnconfirmed means the transaction was accepted by the network but its outcome was not
// observed before the deadline. It is deliberately NOT an error the caller should present as
// failure: the shield may still land, and telling someone their deposit failed when it did not is
// how a user ends up depositing twice.
var ErrShieldUnconfirmed = errors.New("shield submitted but not yet confirmed")

// ShieldNote mirrors the contract's `ShieldNote` struct. All values are hex, 32 bytes each.
type ShieldNote struct {
	Commitment string
	OwnerPk    string
	EpkX       string
	EpkY       string
	EncAmount  string
	EncRho     string
}

// ShieldRequest is everything needed to build one shield invocation.
type ShieldRequest struct {
	// From is the user's Stellar account (G…) — transaction source and the authorising address.
	From string
	// Amount is in the token's own units (stroops for a 7-decimal Stellar asset).
	Amount int64
	Note   ShieldNote
	// Proof components from the on-device shield prover, hex.
	ProofA string
	ProofB string
	ProofC string
}

// ShieldBuilder assembles shield transactions against a deployed pool contract.
type ShieldBuilder struct {
	horizon    *horizonclient.Client
	soroban    *SorobanClient
	contractID string
	passphrase string
}

// NewShieldBuilder wires the Horizon (sequence numbers) and Soroban RPC (simulation) clients.
func NewShieldBuilder(h *horizonclient.Client, s *SorobanClient, contractID, passphrase string) *ShieldBuilder {
	return &ShieldBuilder{horizon: h, soroban: s, contractID: contractID, passphrase: passphrase}
}

// NewShieldBuilderFor builds one from plain configuration, so callers need no Stellar client types.
func NewShieldBuilderFor(horizonURL, sorobanURL, contractID, stellarNetwork string) *ShieldBuilder {
	return NewShieldBuilder(
		&horizonclient.Client{HorizonURL: horizonURL, HTTP: &http.Client{Timeout: 30 * time.Second}},
		NewSorobanClient(sorobanURL),
		contractID,
		NetworkPassphrase(stellarNetwork),
	)
}

// NetworkPassphrase maps a network name to its Stellar passphrase. Anything that is not explicitly
// mainnet is treated as testnet — the safe direction to be wrong in.
func NetworkPassphrase(stellarNetwork string) string {
	if stellarNetwork == "mainnet" {
		return network.PublicNetworkPassphrase
	}
	return network.TestNetworkPassphrase
}

// Build prepares an unsigned, fully-assembled shield transaction.
//
// A simulation failure is returned as an error naming the contract's complaint, because it means the
// call *would* revert — submitting anyway would burn a fee to achieve nothing. The most common cause
// is an invalid proof (contract error #2), since the contract verifies the Groth16 proof before it
// touches the token.
func (b *ShieldBuilder) Build(ctx context.Context, req ShieldRequest) (UnsignedTx, error) {
	args, err := shieldArgs(b.contractID, req)
	if err != nil {
		return UnsignedTx{}, err
	}

	acct, err := b.horizon.AccountDetail(horizonclient.AccountRequest{AccountID: req.From})
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("load account: %w", err)
	}

	op := &txnbuild.InvokeHostFunction{
		HostFunction: xdr.HostFunction{
			Type:           xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
			InvokeContract: &args,
		},
		SourceAccount: req.From,
	}

	// Pass 1: no footprint yet — this envelope exists only to be simulated.
	draft, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        &acct,
		IncrementSequenceNum: true,
		BaseFee:              txnbuild.MinBaseFee,
		Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(300)},
		Operations:           []txnbuild.Operation{op},
	})
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("build draft tx: %w", err)
	}
	draftXDR, err := draft.Base64()
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("encode draft tx: %w", err)
	}

	sim, err := b.soroban.Simulate(ctx, draftXDR)
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("simulate shield: %w", err)
	}
	if sim.Failed() {
		return UnsignedTx{}, fmt.Errorf("%w: %s", ErrShieldRejected, sim.Error)
	}

	var sorobanData xdr.SorobanTransactionData
	if err := xdr.SafeUnmarshalBase64(sim.TransactionData, &sorobanData); err != nil {
		return UnsignedTx{}, fmt.Errorf("decode simulated transaction data: %w", err)
	}
	op.Ext = xdr.TransactionExt{V: 1, SorobanData: &sorobanData}

	// Attach the authorisation tree the simulation produced.
	//
	// Without it the contract's `from.require_auth()` has no entry to match, panics, and the
	// transaction fails on-chain as `trapped` — even though simulation passed, because simulation
	// infers authorisation rather than requiring it. Source-account credentials still need an entry
	// present saying exactly that; they do not make the tree optional.
	if len(sim.Auth) > 0 {
		auth := make([]xdr.SorobanAuthorizationEntry, 0, len(sim.Auth))
		for _, raw := range sim.Auth {
			var entry xdr.SorobanAuthorizationEntry
			if err := xdr.SafeUnmarshalBase64(raw, &entry); err != nil {
				return UnsignedTx{}, fmt.Errorf("decode simulated auth entry: %w", err)
			}
			auth = append(auth, entry)
		}
		op.Auth = auth
	}

	// Pass 2: rebuild with the footprint and the resource fee the network quoted. The sequence
	// number must not advance again, so start from the same account snapshot.
	acct.Sequence--
	final, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        &acct,
		IncrementSequenceNum: true,
		BaseFee:              txnbuild.MinBaseFee + sim.MinResourceFee,
		Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(300)},
		Operations:           []txnbuild.Operation{op},
	})
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("build shield tx: %w", err)
	}

	envelope, err := final.Base64()
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("encode shield tx: %w", err)
	}
	hash, err := final.HashHex(b.passphrase)
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("hash shield tx: %w", err)
	}
	// A generic XDR summary would say "invoke a contract", which tells the user nothing about what
	// they are approving. State the actual effect instead — see Docs/deposit-flow.md on not
	// blind-signing.
	summary := fmt.Sprintf("Move %s into the private pool", formatStroops(req.Amount))
	return UnsignedTx{XDR: envelope, Hash: hash, Network: b.passphrase, Summary: summary}, nil
}

// SubmitSigned attaches the phone's signature to a prepared shield envelope and submits it.
//
// Submission goes through Soroban RPC rather than Horizon so the settled contract outcome can be
// read back: Horizon would report the transaction as applied without telling us whether the
// invocation itself reverted.
//
// `AddSignatureBase64` re-derives the hash from the envelope and verifies it against the public key,
// so a signature that does not match is rejected here — before anything reaches the network.
func (b *ShieldBuilder) SubmitSigned(ctx context.Context, envelopeXDR, publicKey, signatureB64 string) (string, error) {
	generic, err := txnbuild.TransactionFromXDR(envelopeXDR)
	if err != nil {
		return "", fmt.Errorf("parse envelope: %w", err)
	}
	tx, ok := generic.Transaction()
	if !ok {
		return "", fmt.Errorf("not a simple transaction")
	}
	signed, err := tx.AddSignatureBase64(b.passphrase, publicKey, signatureB64)
	if err != nil {
		return "", fmt.Errorf("attach signature: %w", err)
	}
	signedXDR, err := signed.Base64()
	if err != nil {
		return "", fmt.Errorf("encode signed tx: %w", err)
	}

	sent, err := b.soroban.Send(ctx, signedXDR)
	if err != nil {
		return "", fmt.Errorf("submit shield: %w", err)
	}
	switch sent.Status {
	case "PENDING", "DUPLICATE":
		// Accepted. DUPLICATE means this exact transaction was already submitted — same outcome.
	case "TRY_AGAIN_LATER":
		return "", fmt.Errorf("network is congested, try again shortly")
	default:
		return "", fmt.Errorf("%w: %s %s", ErrShieldRejected, sent.Status, sent.ErrorResultXDR)
	}

	// Wait for the outcome. A shield that lands but reverts must not be reported as success — the
	// wallet would show money it does not have in the pool.
	res, err := b.soroban.AwaitTransaction(ctx, sent.Hash, 2*time.Second)
	if err != nil {
		// Submitted but unconfirmed. The hash is returned so the caller can report "processing"
		// rather than "failed" — the transaction may still land.
		return sent.Hash, fmt.Errorf("%w: %v", ErrShieldUnconfirmed, err)
	}
	if res.Status != "SUCCESS" {
		return sent.Hash, fmt.Errorf("%w: %s", ErrShieldRejected, res.ResultXDR)
	}
	return sent.Hash, nil
}

// shieldArgs builds the ScVal argument vector for `shield(from, amount, note, proof)`.
func shieldArgs(contractID string, req ShieldRequest) (xdr.InvokeContractArgs, error) {
	if req.Amount <= 0 {
		return xdr.InvokeContractArgs{}, fmt.Errorf("shield amount must be positive")
	}
	contract, err := contractAddress(contractID)
	if err != nil {
		return xdr.InvokeContractArgs{}, err
	}
	from, err := accountAddress(req.From)
	if err != nil {
		return xdr.InvokeContractArgs{}, err
	}

	// Struct fields become a map keyed by symbol, and the host requires keys in ascending order.
	note, err := scMap([]scField{
		{"commitment", req.Note.Commitment},
		{"enc_amount", req.Note.EncAmount},
		{"enc_rho", req.Note.EncRho},
		{"epk_x", req.Note.EpkX},
		{"epk_y", req.Note.EpkY},
		{"owner_pk", req.Note.OwnerPk},
	}, fieldLen)
	if err != nil {
		return xdr.InvokeContractArgs{}, fmt.Errorf("note: %w", err)
	}

	proofA, err := scBytesN("a", req.ProofA, proofALen)
	if err != nil {
		return xdr.InvokeContractArgs{}, fmt.Errorf("proof: %w", err)
	}
	proofB, err := scBytesN("b", req.ProofB, proofBLen)
	if err != nil {
		return xdr.InvokeContractArgs{}, fmt.Errorf("proof: %w", err)
	}
	proofC, err := scBytesN("c", req.ProofC, proofCLen)
	if err != nil {
		return xdr.InvokeContractArgs{}, fmt.Errorf("proof: %w", err)
	}
	proof := xdr.ScMap{
		{Key: scSymbol("a"), Val: proofA},
		{Key: scSymbol("b"), Val: proofB},
		{Key: scSymbol("c"), Val: proofC},
	}

	notePtr, proofPtr := &note, &proof
	fn := xdr.ScSymbol("shield")
	return xdr.InvokeContractArgs{
		ContractAddress: contract,
		FunctionName:    fn,
		Args: []xdr.ScVal{
			{Type: xdr.ScValTypeScvAddress, Address: &from},
			scI128(req.Amount),
			{Type: xdr.ScValTypeScvMap, Map: &notePtr},
			{Type: xdr.ScValTypeScvMap, Map: &proofPtr},
		},
	}, nil
}

type scField struct{ key, hexValue string }

// scMap builds a sorted symbol-keyed map of fixed-width byte fields.
func scMap(fields []scField, width int) (xdr.ScMap, error) {
	out := make(xdr.ScMap, 0, len(fields))
	for _, f := range fields {
		val, err := scBytesN(f.key, f.hexValue, width)
		if err != nil {
			return nil, err
		}
		out = append(out, xdr.ScMapEntry{Key: scSymbol(f.key), Val: val})
	}
	return out, nil
}

// scBytesN decodes a hex field and checks its width, so a truncated value fails here — naming the
// field — instead of as an opaque host error.
func scBytesN(name, hexValue string, want int) (xdr.ScVal, error) {
	raw, err := hex.DecodeString(hexValue)
	if err != nil {
		return xdr.ScVal{}, fmt.Errorf("%s is not hex: %w", name, err)
	}
	if len(raw) != want {
		return xdr.ScVal{}, fmt.Errorf("%s must be %d bytes, got %d", name, want, len(raw))
	}
	b := xdr.ScBytes(raw)
	return xdr.ScVal{Type: xdr.ScValTypeScvBytes, Bytes: &b}, nil
}

func scSymbol(s string) xdr.ScVal {
	sym := xdr.ScSymbol(s)
	return xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &sym}
}

// scI128 widens a positive int64 to the i128 the contract takes. Callers reject non-positive
// amounts, so the high word is always zero.
func scI128(v int64) xdr.ScVal {
	parts := xdr.Int128Parts{Hi: xdr.Int64(0), Lo: xdr.Uint64(v)}
	return xdr.ScVal{Type: xdr.ScValTypeScvI128, I128: &parts}
}

func contractAddress(contractID string) (xdr.ScAddress, error) {
	decoded, err := strkey.Decode(strkey.VersionByteContract, contractID)
	if err != nil {
		return xdr.ScAddress{}, fmt.Errorf("not a valid contract id: %w", err)
	}
	var id xdr.ContractId
	copy(id[:], decoded)
	return xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeContract, ContractId: &id}, nil
}

func accountAddress(address string) (xdr.ScAddress, error) {
	var account xdr.AccountId
	if err := account.SetAddress(address); err != nil {
		return xdr.ScAddress{}, fmt.Errorf("not a valid Stellar address: %w", err)
	}
	return xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeAccount, AccountId: &account}, nil
}

// formatStroops renders a 7-decimal token amount for the approval summary.
func formatStroops(v int64) string {
	whole := v / 1e7
	frac := v % 1e7
	if frac == 0 {
		return fmt.Sprintf("%d", whole)
	}
	return fmt.Sprintf("%d.%07d", whole, frac)
}
