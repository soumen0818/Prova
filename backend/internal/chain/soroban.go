package chain

// Minimal Soroban RPC client — simulate, send, poll.
//
// The stellar/go SDK builds Soroban operations but ships no RPC client, so the three JSON-RPC calls
// a state-changing invocation needs are implemented here. Same shape as events.go / pool_events.go,
// which already speak raw JSON-RPC to the same endpoint.
//
// Why simulation is mandatory rather than an optimisation: a Soroban transaction must declare, up
// front, every ledger entry it will read or write and how much CPU it will burn. Only the network
// can compute that. Submitting without it is rejected, so every invocation is build → simulate →
// re-assemble with the returned footprint → sign → send.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// SorobanClient talks to a Soroban RPC endpoint.
type SorobanClient struct {
	RPCURL string
	HTTP   *http.Client
}

// NewSorobanClient builds a client for the given RPC URL.
func NewSorobanClient(rpcURL string) *SorobanClient {
	return &SorobanClient{RPCURL: rpcURL, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

// SimulateResult is the part of a simulateTransaction response we act on.
type SimulateResult struct {
	// TransactionData is base64 SorobanTransactionData: the footprint and resource limits that must
	// be attached to the transaction before it can be submitted.
	TransactionData string
	// MinResourceFee is the resource fee, in stroops, to add on top of the classic base fee.
	MinResourceFee int64
	// Error is the contract/host error text when simulation failed. Non-empty means the invocation
	// would fail on-chain; the caller should surface it rather than submit.
	Error string
	// Events are diagnostic events emitted during simulation (base64 XDR), useful for debugging a
	// failed simulation.
	Events []string
}

// Failed reports whether the simulation itself rejected the invocation.
func (s SimulateResult) Failed() bool { return s.Error != "" }

type rpcEnvelope struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// call performs one JSON-RPC round trip and unmarshals `result` into out.
func (c *SorobanClient) call(ctx context.Context, method string, params any, out any) error {
	body, err := json.Marshal(rpcReq{JSONRPC: "2.0", ID: 1, Method: method, Params: params})
	if err != nil {
		return fmt.Errorf("encode %s request: %w", method, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.RPCURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build %s request: %w", method, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: rpc status %d", method, resp.StatusCode)
	}

	var env rpcEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return fmt.Errorf("decode %s response: %w", method, err)
	}
	if env.Error != nil {
		return fmt.Errorf("%s: rpc error %d: %s", method, env.Error.Code, env.Error.Message)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return fmt.Errorf("decode %s result: %w", method, err)
	}
	return nil
}

// Simulate runs simulateTransaction against an unsigned envelope.
//
// A simulation that reports a contract error is **not** a transport failure: it is the network
// telling us the call would revert. That is returned in SimulateResult.Error rather than as an
// error, so callers can distinguish "the chain says no" from "we could not reach the chain".
func (c *SorobanClient) Simulate(ctx context.Context, envelopeXDR string) (SimulateResult, error) {
	var raw struct {
		TransactionData string `json:"transactionData"`
		MinResourceFee  string `json:"minResourceFee"`
		Error           string `json:"error"`
		Events          []string `json:"events"`
		// Present when the invocation would trap; the SDK reports it inside `error` too.
		RestorePreamble json.RawMessage `json:"restorePreamble"`
	}
	if err := c.call(ctx, "simulateTransaction", map[string]any{"transaction": envelopeXDR}, &raw); err != nil {
		return SimulateResult{}, err
	}
	out := SimulateResult{
		TransactionData: raw.TransactionData,
		Error:           raw.Error,
		Events:          raw.Events,
	}
	if raw.MinResourceFee != "" {
		fee, err := strconv.ParseInt(raw.MinResourceFee, 10, 64)
		if err != nil {
			return SimulateResult{}, fmt.Errorf("parse minResourceFee %q: %w", raw.MinResourceFee, err)
		}
		out.MinResourceFee = fee
	}
	return out, nil
}

// SendResult is the immediate answer to sendTransaction — acceptance, not confirmation.
type SendResult struct {
	Hash string
	// Status is PENDING, DUPLICATE, TRY_AGAIN_LATER or ERROR.
	Status string
	// ErrorResultXDR is set when Status is ERROR.
	ErrorResultXDR string
}

// Send submits a signed envelope. A PENDING status means accepted for inclusion, not succeeded —
// call GetTransaction to learn the outcome.
func (c *SorobanClient) Send(ctx context.Context, signedXDR string) (SendResult, error) {
	var raw struct {
		Hash           string `json:"hash"`
		Status         string `json:"status"`
		ErrorResultXDR string `json:"errorResultXdr"`
	}
	if err := c.call(ctx, "sendTransaction", map[string]any{"transaction": signedXDR}, &raw); err != nil {
		return SendResult{}, err
	}
	return SendResult{Hash: raw.Hash, Status: raw.Status, ErrorResultXDR: raw.ErrorResultXDR}, nil
}

// TxResult is the settled outcome of a submitted transaction.
type TxResult struct {
	// Status is NOT_FOUND, SUCCESS or FAILED.
	Status string
	// ResultXDR is the classic TransactionResult (base64) — carries the contract error on FAILED.
	ResultXDR string
}

// GetTransaction reads a submitted transaction's status. NOT_FOUND simply means the network has not
// closed a ledger containing it yet.
func (c *SorobanClient) GetTransaction(ctx context.Context, hash string) (TxResult, error) {
	var raw struct {
		Status    string `json:"status"`
		ResultXDR string `json:"resultXdr"`
	}
	if err := c.call(ctx, "getTransaction", map[string]any{"hash": hash}, &raw); err != nil {
		return TxResult{}, err
	}
	return TxResult{Status: raw.Status, ResultXDR: raw.ResultXDR}, nil
}

// AwaitTransaction polls until the transaction settles or ctx expires.
//
// Soroban RPC answers NOT_FOUND until the containing ledger closes (~5 s), so a submit that has not
// "arrived" yet is the normal case, not a failure.
func (c *SorobanClient) AwaitTransaction(ctx context.Context, hash string, every time.Duration) (TxResult, error) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		res, err := c.GetTransaction(ctx, hash)
		if err != nil {
			return TxResult{}, err
		}
		if res.Status != "NOT_FOUND" {
			return res, nil
		}
		select {
		case <-ctx.Done():
			return TxResult{}, fmt.Errorf("timed out waiting for %s: %w", hash, ctx.Err())
		case <-ticker.C:
		}
	}
}
