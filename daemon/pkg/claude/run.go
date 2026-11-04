package claude

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os/exec"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	TurnInProgress  = "inProgress"
	TurnCompleted   = "completed"
	TurnFailed      = "failed"
	TurnInterrupted = "interrupted"
	// TurnUnknown is reported when the process ended without a final result
	// that proves success or failure, for example a crash or shutdown kill.
	TurnUnknown = "unknown"

	// A result line carries the full final text; allow JSON escaping overhead.
	maxStreamLineBytes = protocol.MaxDaemonResultMessageBytes
	maxStderrBytes     = 16 << 10
	resultSuccess      = "success"
)

// streamEvent holds the stream-json fields this adapter relies on.
type streamEvent struct {
	Type              string            `json:"type"`
	Subtype           string            `json:"subtype"`
	SessionID         string            `json:"session_id"`
	IsError           bool              `json:"is_error"`
	Result            *string           `json:"result"`
	PermissionDenials []json.RawMessage `json:"permission_denials"`
}

// run is one daemon-launched headless turn. Its observation is final once done closes.
type run struct {
	sessionID string
	turnID    string
	cmd       *exec.Cmd
	done      chan struct{}

	mu          sync.Mutex
	observation codex.TurnObservation
	sawInit     bool
	timedOut    bool
	stopped     bool
	endedAt     time.Time
}

func (r *run) snapshot() codex.TurnObservation {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.observation
}

// consume parses stdout until EOF. Only the final result event decides the outcome.
func (r *run) consume(stdout io.Reader, nativeID string) (result *streamEvent, mismatch bool, err error) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64<<10), maxStreamLineBytes)
	for scanner.Scan() {
		var event streamEvent
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			continue
		}
		if event.SessionID != "" && event.SessionID != nativeID {
			return nil, true, nil
		}
		switch {
		case event.Type == "system" && event.Subtype == "init":
			r.mu.Lock()
			r.sawInit = true
			r.mu.Unlock()
		case event.Type == "result":
			final := event
			result = &final
		}
	}
	return result, false, scanner.Err()
}

// supervise waits for the process, enforces the run timeout and records the
// single final observation.
func (a *Adapter) supervise(r *run, stdout io.ReadCloser, stderr *boundedBuffer, nativeID string) {
	defer close(r.done)
	timer := time.AfterFunc(a.cfg.RunTimeout, func() {
		r.mu.Lock()
		r.timedOut = true
		r.mu.Unlock()
		a.interrupt(r)
	})
	result, mismatch, readErr := r.consume(stdout, nativeID)
	if mismatch {
		// A different session ID means the CLI did not continue the exact
		// target; stop it and never report success for another conversation.
		if err := killProcessGroup(r.cmd); err != nil {
			log.Printf("claude run cleanup failed: %v", err)
		}
	}
	if readErr != nil {
		if err := killProcessGroup(r.cmd); err != nil {
			log.Printf("claude run cleanup failed: %v", err)
		}
	}
	if _, err := io.Copy(io.Discard, stdout); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		log.Printf("claude run output drain failed: %v", err)
	}
	waitErr := r.cmd.Wait()
	timer.Stop()
	ended := a.now()
	r.mu.Lock()
	r.endedAt = ended
	r.observation = decide(result, mismatch, readErr, waitErr, r.sawInit, r.timedOut, r.stopped, stderr)
	r.mu.Unlock()
	a.markFinished(r, ended)
}

// decide maps process evidence to a turn state. Only an explicit success result
// with a zero exit is completed; a run that may have executed without a final
// result stays unknown so it is never retried or reported as done.
func decide(result *streamEvent, mismatch bool, readErr, waitErr error, sawInit, timedOut, stopped bool, stderr *boundedBuffer) codex.TurnObservation {
	var exitErr *exec.ExitError
	exitedNonZero := errors.As(waitErr, &exitErr) && exitErr.Exited()
	switch {
	case mismatch:
		return codex.TurnObservation{Status: TurnUnknown, Error: "Claude Code reported a different session; outcome unconfirmed"}
	case readErr != nil:
		return codex.TurnObservation{Status: TurnUnknown, Error: protocol.ErrTurnOutputLimit.Error()}
	case result != nil && !result.IsError && result.Subtype == resultSuccess:
		if waitErr != nil {
			return codex.TurnObservation{Status: TurnFailed, Error: "Claude Code exited with an error after its final result"}
		}
		output := ""
		if result.Result != nil {
			output = *result.Result
		}
		return codex.TurnObservation{Status: TurnCompleted, Output: output}
	case result != nil:
		message := "Claude Code turn failed: " + result.Subtype
		if result.Result != nil && *result.Result != "" {
			message += ": " + *result.Result
		}
		return codex.TurnObservation{Status: TurnFailed, Error: message}
	case timedOut:
		return codex.TurnObservation{Status: TurnInterrupted, Error: "Claude Code turn exceeded the run timeout and was interrupted"}
	case stopped:
		return codex.TurnObservation{Status: TurnUnknown, Error: "Claude Code turn stopped by daemon shutdown; outcome unconfirmed"}
	case result == nil && !sawInit && exitedNonZero:
		// The CLI rejected the command before loading the session, for example
		// when the session is open elsewhere or does not exist.
		message := "Claude Code refused to resume the session"
		if detail := stderr.String(); detail != "" {
			message += ": " + detail
		}
		return codex.TurnObservation{Status: TurnFailed, Error: message}
	}
	return codex.TurnObservation{Status: TurnUnknown, Error: "Claude Code exited without a final result; outcome unconfirmed"}
}

// interrupt asks the CLI to end the turn, then kills the group after a grace period.
func (a *Adapter) interrupt(r *run) {
	if err := interruptProcessGroup(r.cmd); err != nil {
		log.Printf("claude run interrupt failed: %v", err)
	}
	go func() {
		select {
		case <-r.done:
		case <-time.After(a.cfg.InterruptGrace):
			if err := killProcessGroup(r.cmd); err != nil {
				log.Printf("claude run kill failed: %v", err)
			}
		}
	}()
}
