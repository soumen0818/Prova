package chain

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/stellar/go/xdr"
)

// TransferEvent is one `transfer` event emitted by the verifier contract.
type TransferEvent struct {
	Commitment string
	Nullifier  string
	TxHash     string
	Ledger     uint32
}

// EventsClient reads contract events from a Soroban RPC endpoint (JSON-RPC `getEvents`).
type EventsClient struct {
	RPCURL     string
	ContractID string
	HTTP       *http.Client
}

// NewEventsClient builds a client for the given RPC + contract.
func NewEventsClient(rpcURL, contractID string) *EventsClient {
	return &EventsClient{RPCURL: rpcURL, ContractID: contractID, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type getEventsResult struct {
	Events []struct {
		Ledger int    `json:"ledger"`
		TxHash string `json:"txHash"`
		Value  string `json:"value"`
	} `json:"events"`
	Cursor       string `json:"cursor"`
	LatestLedger int    `json:"latestLedger"`
}

// GetTransferEvents fetches `transfer` events. Pass a cursor to page forward, or startLedger to
// begin a fresh scan (exactly one is used). Returns the events, the next cursor, and latest ledger.
func (c *EventsClient) GetTransferEvents(ctx context.Context, startLedger uint32, cursor string) ([]TransferEvent, string, uint32, error) {
	pagination := map[string]any{"limit": 100}
	params := map[string]any{
		"filters": []map[string]any{{
			"type":        "contract",
			"contractIds": []string{c.ContractID},
		}},
		"pagination": pagination,
	}
	if cursor != "" {
		pagination["cursor"] = cursor
	} else {
		params["startLedger"] = startLedger
	}

	body, _ := json.Marshal(rpcReq{JSONRPC: "2.0", ID: 1, Method: "getEvents", Params: params})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.RPCURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, "", 0, err
	}
	defer resp.Body.Close()

	var out struct {
		Result getEventsResult `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, "", 0, err
	}
	if out.Error != nil {
		return nil, "", 0, fmt.Errorf("getEvents: %s", out.Error.Message)
	}

	events := make([]TransferEvent, 0, len(out.Result.Events))
	for _, e := range out.Result.Events {
		commitment, nullifier, perr := parseTransferValue(e.Value)
		if perr != nil {
			continue // not a well-formed transfer event
		}
		events = append(events, TransferEvent{
			Commitment: commitment,
			Nullifier:  nullifier,
			TxHash:     e.TxHash,
			Ledger:     uint32(e.Ledger),
		})
	}
	return events, out.Result.Cursor, uint32(out.Result.LatestLedger), nil
}

// parseTransferValue decodes the event value (XDR ScVal = vec[bytes commitment, bytes nullifier]).
func parseTransferValue(b64 string) (string, string, error) {
	var v xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(b64, &v); err != nil {
		return "", "", err
	}
	vec, ok := v.GetVec()
	if !ok || vec == nil || len(*vec) != 2 {
		return "", "", fmt.Errorf("not a 2-element vec")
	}
	cm, ok := (*vec)[0].GetBytes()
	if !ok {
		return "", "", fmt.Errorf("commitment not bytes")
	}
	nf, ok := (*vec)[1].GetBytes()
	if !ok {
		return "", "", fmt.Errorf("nullifier not bytes")
	}
	return hex.EncodeToString(cm), hex.EncodeToString(nf), nil
}
