package lifecycle

import "errors"

var (
	// ErrIllegalTransition means the move is not in the machine — the states are both real, the
	// path between them is not.
	ErrIllegalTransition = errors.New("illegal transfer state transition")

	// ErrTerminal means the transfer has already finished. Distinguished from a plain illegal
	// transition because the operational response differs: an illegal move is usually a bug in the
	// caller, while a move out of a terminal state is usually a duplicate or late-arriving event
	// that should be ignored rather than investigated.
	ErrTerminal = errors.New("transfer is already in a terminal state")

	// ErrUnknownStatus means the value is not part of the machine at all — typically a row written
	// by a different version of the schema, which is a migration question rather than a logic one.
	ErrUnknownStatus = errors.New("unknown transfer status")
)
