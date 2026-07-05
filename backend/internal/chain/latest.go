package chain

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
)

// GetLatestLedger returns the current ledger sequence from the RPC.
func (c *EventsClient) GetLatestLedger(ctx context.Context) (uint32, error) {
	body, _ := json.Marshal(rpcReq{JSONRPC: "2.0", ID: 1, Method: "getLatestLedger"})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.RPCURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var out struct {
		Result struct {
			Sequence uint32 `json:"sequence"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	return out.Result.Sequence, nil
}
