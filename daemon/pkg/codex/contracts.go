package codex

import (
	"context"
	"errors"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const ProviderCodexApp = "codex-app"

// SessionAdapter abstracts discovery, reading, and sending on an existing session.
type SessionAdapter interface {
	DiscoverSessions(context.Context) ([]protocol.Session, error)
	ReadSession(context.Context, string) (string, error)
	SendPrompt(context.Context, string, string) (string, error)
}

// ResumeSender sends once on its configured server, explicitly restoring the
// thread if needed. ResumeSend returns the exact native turn ID, never output.
// Discovery, readiness and inspection must not invoke it.
type ResumeSender interface {
	Endpoint() string
	ResumeSend(context.Context, string, string) (string, error)
}

type HistoryReader interface {
	ReadHistory(context.Context, string, string, int) (protocol.SessionHistory, error)
}

// TurnObservation records only the state and output of an explicitly identified turn.
type TurnObservation struct {
	Status string
	Output string
	Error  string
}

type TurnInspector interface {
	InspectTurn(context.Context, string, string) (TurnObservation, error)
}

// UncertainError reports a dispatch whose acknowledgement was not established.
type UncertainError struct{ Err error }

func (e *UncertainError) Error() string { return e.Err.Error() }
func (e *UncertainError) Unwrap() error { return e.Err }

func IsUncertain(err error) bool {
	var uncertain *UncertainError
	return errors.As(err, &uncertain)
}
