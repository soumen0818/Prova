package chain

import (
	"encoding/hex"
	"strings"
	"testing"

	"github.com/stellar/go/xdr"
)

// Event decoding is the indexer's only source of truth, and a mistake here is silent: a misread
// `note` is money its owner can never find, and a misread `root` means notes never look spendable.
// So these tests build real XDR the way the contract emits it and check every field, plus every way
// a malformed event must be rejected rather than half-read.

func scvBytes(b []byte) xdr.ScVal {
	sb := xdr.ScBytes(b)
	return xdr.ScVal{Type: xdr.ScValTypeScvBytes, Bytes: &sb}
}

func scvU32(n uint32) xdr.ScVal {
	u := xdr.Uint32(n)
	return xdr.ScVal{Type: xdr.ScValTypeScvU32, U32: &u}
}

func scvVec(vals ...xdr.ScVal) xdr.ScVal {
	v := xdr.ScVec(vals)
	pv := &v
	return xdr.ScVal{Type: xdr.ScValTypeScvVec, Vec: &pv}
}

func scvSym(t *testing.T, s string) string {
	t.Helper()
	sym := xdr.ScSymbol(s)
	b64, err := xdr.MarshalBase64(xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &sym})
	if err != nil {
		t.Fatalf("marshal symbol: %v", err)
	}
	return b64
}

func b64(t *testing.T, v xdr.ScVal) string {
	t.Helper()
	s, err := xdr.MarshalBase64(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return s
}

// field is a distinct 32-byte value, so a field swap in the decoder shows up as a wrong value
// rather than accidentally passing.
func field(b byte) []byte {
	out := make([]byte, 32)
	for i := range out {
		out[i] = b
	}
	return out
}

func TestDecodeNoteEvent(t *testing.T) {
	value := b64(t, scvVec(
		scvBytes(field(0x11)), // commitment
		scvU32(7),             // queue index
		scvU32(1),             // slot
		scvBytes(field(0x22)), // epk x
		scvBytes(field(0x33)), // epk y
		scvBytes(field(0x44)), // enc amount
		scvBytes(field(0x55)), // enc rho
	))

	n, err := decodeNoteEvent(value)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if n.Commitment != hex.EncodeToString(field(0x11)) {
		t.Errorf("commitment = %s", n.Commitment)
	}
	if n.QueueIndex != 7 {
		t.Errorf("queueIndex = %d, want 7", n.QueueIndex)
	}
	// Slot is folded into the decryption key, so losing it makes the note undecryptable even though
	// every other field is intact.
	if n.Slot != 1 {
		t.Errorf("slot = %d, want 1", n.Slot)
	}
	if n.EpkX != hex.EncodeToString(field(0x22)) || n.EpkY != hex.EncodeToString(field(0x33)) {
		t.Errorf("ephemeral key decoded wrong: x=%s y=%s", n.EpkX, n.EpkY)
	}
	if n.EncAmount != hex.EncodeToString(field(0x44)) || n.EncRho != hex.EncodeToString(field(0x55)) {
		t.Errorf("payload decoded wrong: amount=%s rho=%s", n.EncAmount, n.EncRho)
	}
}

func TestDecodeRootEvent(t *testing.T) {
	r, err := decodeRootEvent(b64(t, scvVec(scvBytes(field(0xAB)), scvU32(24), scvU32(8))))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if r.Root != hex.EncodeToString(field(0xAB)) {
		t.Errorf("root = %s", r.Root)
	}
	// NextIndex is the tree size AFTER the fold; the store derives the batch's start from it, so a
	// mix-up with `count` would assign every leaf index in the batch wrongly.
	if r.NextIndex != 24 || r.Count != 8 {
		t.Errorf("nextIndex/count = %d/%d, want 24/8", r.NextIndex, r.Count)
	}
}

func TestDecodeSpendEvent(t *testing.T) {
	s, err := decodeSpendEvent(b64(t, scvBytes(field(0xCD))))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if s.Nullifier != hex.EncodeToString(field(0xCD)) {
		t.Errorf("nullifier = %s", s.Nullifier)
	}
}

// A contract upgrade that changed an event's shape must be rejected, not read as garbage and written
// to the database as fact.
func TestMalformedEventsAreRejected(t *testing.T) {
	tests := []struct {
		name  string
		value string
		fn    func(string) error
	}{
		{
			name:  "note with too few fields",
			value: b64(t, scvVec(scvBytes(field(1)), scvU32(0))),
			fn:    func(v string) error { _, err := decodeNoteEvent(v); return err },
		},
		{
			name: "note with too many fields",
			value: b64(t, scvVec(scvBytes(field(1)), scvU32(0), scvU32(0),
				scvBytes(field(2)), scvBytes(field(3)), scvBytes(field(4)), scvBytes(field(5)), scvU32(9))),
			fn: func(v string) error { _, err := decodeNoteEvent(v); return err },
		},
		{
			name: "note with a wrongly-typed field",
			value: b64(t, scvVec(scvU32(1), scvU32(0), scvU32(0),
				scvBytes(field(2)), scvBytes(field(3)), scvBytes(field(4)), scvBytes(field(5)))),
			fn: func(v string) error { _, err := decodeNoteEvent(v); return err },
		},
		{
			name:  "root with too few fields",
			value: b64(t, scvVec(scvBytes(field(1)))),
			fn:    func(v string) error { _, err := decodeRootEvent(v); return err },
		},
		{
			name:  "spend that is not bytes",
			value: b64(t, scvU32(5)),
			fn:    func(v string) error { _, err := decodeSpendEvent(v); return err },
		},
		{
			name:  "not valid XDR at all",
			value: "!!!not-base64!!!",
			fn:    func(v string) error { _, err := decodeNoteEvent(v); return err },
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.fn(tc.value); err == nil {
				t.Fatal("expected an error, got nil — a malformed event must never be silently accepted")
			}
		})
	}
}

func TestFirstTopicSymbol(t *testing.T) {
	name, err := firstTopicSymbol([]string{scvSym(t, "note")})
	if err != nil || name != "note" {
		t.Fatalf("got %q, %v", name, err)
	}

	// Events from other contracts (the token SAC emits `transfer`) must be identifiable so the
	// indexer can ignore them rather than fail the whole page.
	name, err = firstTopicSymbol([]string{scvSym(t, "transfer")})
	if err != nil || name != "transfer" {
		t.Fatalf("got %q, %v", name, err)
	}

	if _, err := firstTopicSymbol(nil); err == nil {
		t.Error("an event with no topics must be rejected")
	}
	if _, err := firstTopicSymbol([]string{b64(t, scvU32(1))}); err == nil {
		t.Error("a non-symbol topic must be rejected")
	}
}

func TestScVecArityIsChecked(t *testing.T) {
	v := b64(t, scvVec(scvU32(1), scvU32(2)))
	if _, err := scVec(v, 2); err != nil {
		t.Fatalf("correct arity should decode: %v", err)
	}
	_, err := scVec(v, 3)
	if err == nil || !strings.Contains(err.Error(), "expected 3") {
		t.Fatalf("arity mismatch must be reported, got %v", err)
	}
}
