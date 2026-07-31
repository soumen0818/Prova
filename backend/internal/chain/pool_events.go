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

// Pool event decoding (Docs/shielded-pool.md §10.7).
//
// The contract publishes three topics, and between them they are the *complete* record — the
// indexer has no privileged view and rebuilds everything by replaying these:
//
//	note   (commitment, queueIndex, slot, epkX, epkY, encAmount, encRho)
//	root   (root, nextIndex, count)
//	spend  (nullifier)
//
// A decoding mistake here is quiet and expensive: a dropped `note` is money its owner can never
// find, and a dropped `root` means notes never look spendable. So every field is length-checked and
// anything malformed is surfaced rather than skipped.

// PoolNoteEvent is one commitment queued by shield/transact/unshield, with its encrypted payload.
type PoolNoteEvent struct {
	Commitment string
	QueueIndex int64
	Slot       int16
	EpkX       string
	EpkY       string
	EncAmount  string
	EncRho     string
	Ledger     int64
	TxHash     string
}

// PoolRootEvent is one fold: the tree advanced to Root, now holding NextIndex leaves.
type PoolRootEvent struct {
	Root      string
	NextIndex int64
	Count     int
	Ledger    int64
	TxHash    string
}

// PoolSpendEvent is a nullifier published by a spend.
type PoolSpendEvent struct {
	Nullifier string
	Ledger    int64
	TxHash    string
}

// PoolEvents is one page of decoded pool activity, in ledger order.
type PoolEvents struct {
	Notes  []PoolNoteEvent
	Roots  []PoolRootEvent
	Spends []PoolSpendEvent
	// Cursor to pass to the next call, and the chain tip at the time of reading.
	Cursor       string
	LatestLedger uint32
}

// PoolEventsClient reads shielded-pool events from a Soroban RPC endpoint.
type PoolEventsClient struct {
	RPCURL     string
	ContractID string
	HTTP       *http.Client
}

// NewPoolEventsClient builds a client for the pool contract.
func NewPoolEventsClient(rpcURL, contractID string) *PoolEventsClient {
	return &PoolEventsClient{
		RPCURL:     rpcURL,
		ContractID: contractID,
		HTTP:       &http.Client{Timeout: 30 * time.Second},
	}
}

type poolEventsResult struct {
	Events []struct {
		Ledger int      `json:"ledger"`
		TxHash string   `json:"txHash"`
		Topic  []string `json:"topic"`
		Value  string   `json:"value"`
	} `json:"events"`
	Cursor       string `json:"cursor"`
	LatestLedger int    `json:"latestLedger"`
}

// GetPoolEvents fetches one page. Pass a cursor to page forward, or startLedger for a fresh scan
// (exactly one is used, matching Soroban's getEvents contract).
func (c *PoolEventsClient) GetPoolEvents(ctx context.Context, startLedger uint32, cursor string) (*PoolEvents, error) {
	pagination := map[string]any{"limit": 200}
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
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.RPCURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out struct {
		Result poolEventsResult `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("getEvents: %s", out.Error.Message)
	}

	res := &PoolEvents{
		Cursor:       out.Result.Cursor,
		LatestLedger: uint32(out.Result.LatestLedger),
	}
	for _, e := range out.Result.Events {
		topic, terr := firstTopicSymbol(e.Topic)
		if terr != nil {
			continue // not one of ours (e.g. a token transfer emitted by the SAC)
		}
		ledger := int64(e.Ledger)

		switch topic {
		case "note":
			n, err := decodeNoteEvent(e.Value)
			if err != nil {
				return nil, fmt.Errorf("ledger %d: malformed note event: %w", ledger, err)
			}
			n.Ledger, n.TxHash = ledger, e.TxHash
			res.Notes = append(res.Notes, *n)
		case "root":
			r, err := decodeRootEvent(e.Value)
			if err != nil {
				return nil, fmt.Errorf("ledger %d: malformed root event: %w", ledger, err)
			}
			r.Ledger, r.TxHash = ledger, e.TxHash
			res.Roots = append(res.Roots, *r)
		case "spend":
			s, err := decodeSpendEvent(e.Value)
			if err != nil {
				return nil, fmt.Errorf("ledger %d: malformed spend event: %w", ledger, err)
			}
			s.Ledger, s.TxHash = ledger, e.TxHash
			res.Spends = append(res.Spends, *s)
		}
	}
	return res, nil
}

// firstTopicSymbol decodes the leading topic, which is the event name.
func firstTopicSymbol(topics []string) (string, error) {
	if len(topics) == 0 {
		return "", fmt.Errorf("no topics")
	}
	var v xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(topics[0], &v); err != nil {
		return "", err
	}
	sym, ok := v.GetSym()
	if !ok {
		return "", fmt.Errorf("first topic is not a symbol")
	}
	return string(sym), nil
}

// scVec decodes an ScVal into its vector elements, checking the arity.
//
// Arity is checked rather than assumed: a contract upgrade that changed an event's shape would
// otherwise be read as garbage and written to the database as fact.
func scVec(b64 string, want int) ([]xdr.ScVal, error) {
	var v xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(b64, &v); err != nil {
		return nil, err
	}
	vec, ok := v.GetVec()
	if !ok || vec == nil {
		return nil, fmt.Errorf("not a vec")
	}
	if len(*vec) != want {
		return nil, fmt.Errorf("expected %d fields, got %d", want, len(*vec))
	}
	return *vec, nil
}

func scBytesHex(v xdr.ScVal) (string, error) {
	b, ok := v.GetBytes()
	if !ok {
		return "", fmt.Errorf("not bytes")
	}
	return hex.EncodeToString(b), nil
}

func scU32(v xdr.ScVal) (int64, error) {
	n, ok := v.GetU32()
	if !ok {
		return 0, fmt.Errorf("not a u32")
	}
	return int64(n), nil
}

// decodeNoteEvent reads (commitment, queueIndex, slot, epkX, epkY, encAmount, encRho).
func decodeNoteEvent(b64 string) (*PoolNoteEvent, error) {
	f, err := scVec(b64, 7)
	if err != nil {
		return nil, err
	}
	var n PoolNoteEvent
	if n.Commitment, err = scBytesHex(f[0]); err != nil {
		return nil, fmt.Errorf("commitment: %w", err)
	}
	if n.QueueIndex, err = scU32(f[1]); err != nil {
		return nil, fmt.Errorf("queueIndex: %w", err)
	}
	slot, err := scU32(f[2])
	if err != nil {
		return nil, fmt.Errorf("slot: %w", err)
	}
	n.Slot = int16(slot)
	if n.EpkX, err = scBytesHex(f[3]); err != nil {
		return nil, fmt.Errorf("epkX: %w", err)
	}
	if n.EpkY, err = scBytesHex(f[4]); err != nil {
		return nil, fmt.Errorf("epkY: %w", err)
	}
	if n.EncAmount, err = scBytesHex(f[5]); err != nil {
		return nil, fmt.Errorf("encAmount: %w", err)
	}
	if n.EncRho, err = scBytesHex(f[6]); err != nil {
		return nil, fmt.Errorf("encRho: %w", err)
	}
	return &n, nil
}

// decodeRootEvent reads (root, nextIndex, count).
func decodeRootEvent(b64 string) (*PoolRootEvent, error) {
	f, err := scVec(b64, 3)
	if err != nil {
		return nil, err
	}
	var r PoolRootEvent
	if r.Root, err = scBytesHex(f[0]); err != nil {
		return nil, fmt.Errorf("root: %w", err)
	}
	if r.NextIndex, err = scU32(f[1]); err != nil {
		return nil, fmt.Errorf("nextIndex: %w", err)
	}
	count, err := scU32(f[2])
	if err != nil {
		return nil, fmt.Errorf("count: %w", err)
	}
	r.Count = int(count)
	return &r, nil
}

// decodeSpendEvent reads a bare nullifier.
func decodeSpendEvent(b64 string) (*PoolSpendEvent, error) {
	var v xdr.ScVal
	if err := xdr.SafeUnmarshalBase64(b64, &v); err != nil {
		return nil, err
	}
	nullifier, err := scBytesHex(v)
	if err != nil {
		return nil, fmt.Errorf("nullifier: %w", err)
	}
	return &PoolSpendEvent{Nullifier: nullifier}, nil
}

// GetLatestPoolLedger reports the chain tip, for choosing where a fresh scan starts.
func (c *PoolEventsClient) GetLatestPoolLedger(ctx context.Context) (uint32, error) {
	return (&EventsClient{RPCURL: c.RPCURL, ContractID: c.ContractID, HTTP: c.HTTP}).GetLatestLedger(ctx)
}
