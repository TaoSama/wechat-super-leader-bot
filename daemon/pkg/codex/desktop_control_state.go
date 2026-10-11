package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type desktopControlSettings struct {
	ResumeState  string          `json:"resumeState"`
	Mode         string          `json:"mode"`
	ThreadSource json.RawMessage `json:"threadSource"`
}

var ErrDesktopSendBusy = errors.New("desktop thread is busy, awaiting input, or unknown")

var errDesktopCanonicalDuplicateReference = errors.New("duplicate canonical desktop history entry")

func (s desktopControlSettings) ordinaryResumed() bool {
	// Explicit null defaults to user in the native ordinary-thread predicate.
	// Missing or unknown values remain unavailable rather than being defaulted.
	if s.ThreadSource == nil {
		return false
	}
	var source *string
	if err := json.Unmarshal(s.ThreadSource, &source); err != nil {
		return false
	}
	return s.ResumeState == "resumed" && s.Mode == "default" && (source == nil || *source == "user")
}

type desktopControlTurn struct {
	TurnID string `json:"turnId"`
	Status string `json:"status"`
	Items  []any  `json:"items"`
}

type desktopControlState struct {
	desktopControlSettings
	ID                  string `json:"id"`
	HostID              string `json:"hostId"`
	ThreadStartKind     string `json:"threadStartKind"`
	ThreadRuntimeStatus struct {
		Type        string   `json:"type"`
		ActiveFlags []string `json:"activeFlags"`
	} `json:"threadRuntimeStatus"`
	Requests                   []json.RawMessage    `json:"requests"`
	UnconfirmedTurnSubmissions []json.RawMessage    `json:"unconfirmedTurnSubmissions"`
	Turns                      []desktopControlTurn `json:"turns"`
	TurnHistory                *struct {
		Kind    string `json:"kind"`
		History struct {
			Islands []struct {
				Entries []struct {
					Value string `json:"value"`
				} `json:"entries"`
			} `json:"islands"`
			EntitiesByKey map[string]desktopControlTurn `json:"entitiesByKey"`
		} `json:"history"`
	} `json:"turnHistory"`
}

// snapshot asks the same owner to publish its current state, including when
// already following. No request nonce links the publication to this read:
// in-flight snapshots can satisfy it; revision checks do not prove freshness.
// Patches are not used as receipts.
func (p *preparedDesktopSend) snapshot(ctx context.Context) (*desktopControlState, error) {
	if err := p.deadline(ctx); err != nil {
		return nil, err
	}
	if err := p.c.follow(p.identity.OwnerID, p.identity.SessionID, true); err != nil {
		return nil, err
	}
	for range desktopSkipLimit {
		message, err := p.c.read()
		if err != nil {
			return nil, err
		}
		if message.Type != "broadcast" || message.Method != desktopStateChanged {
			continue
		}
		if message.SourceClientID != p.identity.OwnerID || message.Version != 11 {
			return nil, errors.New("desktop snapshot owner or version mismatch")
		}
		targeted := false
		for _, target := range message.TargetClientIDs {
			targeted = targeted || target == p.c.clientID
		}
		if !targeted {
			return nil, errors.New("desktop snapshot recipient mismatch")
		}
		var params struct {
			ConversationID string `json:"conversationId"`
			HostID         string `json:"hostId"`
			Change         struct {
				Type              string          `json:"type"`
				Revision          *uint64         `json:"revision"`
				ConversationState json.RawMessage `json:"conversationState"`
			} `json:"change"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return nil, errors.New("invalid desktop snapshot envelope")
		}
		if params.ConversationID != p.identity.SessionID || params.HostID != "local" {
			return nil, errors.New("desktop snapshot target mismatch")
		}
		if params.Change.Type == "patches" {
			continue
		}
		if params.Change.Type != "snapshot" || params.Change.Revision == nil || *params.Change.Revision > maxDesktopRevision {
			return nil, errors.New("invalid desktop snapshot identity or revision")
		}
		state, err := decodeDesktopControlState(params.Change.ConversationState)
		if err != nil {
			return nil, err
		}
		if state.ID != p.identity.SessionID || state.HostID != "local" {
			return nil, errors.New("invalid desktop snapshot identity or revision")
		}
		if p.snapshotSeen && *params.Change.Revision < p.revision {
			return nil, errors.New("desktop snapshot revision regressed")
		}
		p.snapshotSeen, p.revision = true, *params.Change.Revision
		return state, nil
	}
	return nil, errors.New("desktop snapshot noise limit exceeded")
}

func (s *desktopControlState) readyToSend() error {
	if !s.ordinaryResumed() || s.ThreadStartKind != "default" {
		return errors.New("unsupported desktop thread kind or resume state")
	}
	if s.ThreadRuntimeStatus.Type != "idle" || len(s.ThreadRuntimeStatus.ActiveFlags) != 0 || s.Requests == nil || len(s.Requests) != 0 || len(s.UnconfirmedTurnSubmissions) != 0 {
		return ErrDesktopSendBusy
	}
	turns, err := s.recordedTurns()
	if err != nil {
		return err
	}
	for _, turn := range turns {
		if turn.Status != "completed" && turn.Status != "failed" && turn.Status != "interrupted" {
			return ErrDesktopSendBusy
		}
	}
	return nil
}

// The native snapshot uses turnId, not the app-server thread/read id field.
// Canonical entries reference entitiesByKey through entry.value.
func (s *desktopControlState) recordedTurns() ([]desktopControlTurn, error) {
	if s.Turns == nil {
		return nil, errors.New("desktop turns missing")
	}
	turns := append([]desktopControlTurn{}, s.Turns...)
	if s.TurnHistory == nil {
		return turns, nil
	}
	if s.TurnHistory.Kind != "canonical" {
		return nil, errors.New("unknown desktop history shape")
	}
	history := s.TurnHistory.History
	if history.Islands == nil || history.EntitiesByKey == nil {
		return nil, errors.New("invalid canonical desktop history")
	}
	seen := make(map[string]struct{})
	for _, island := range history.Islands {
		if island.Entries == nil {
			return nil, errors.New("canonical history entries missing")
		}
		for _, entry := range island.Entries {
			turn, ok := history.EntitiesByKey[entry.Value]
			if !ok || entry.Value == "" {
				return nil, errors.New("canonical history entity missing")
			}
			if _, duplicate := seen[entry.Value]; duplicate {
				return nil, errDesktopCanonicalDuplicateReference
			}
			seen[entry.Value] = struct{}{}
			turns = append(turns, turn)
		}
	}
	return turns, nil
}

// InspectTurn reads the explicitly requested turn only. An unloaded owner,
// evicted turn, or conflicting representation is unavailable, never completed.
func (d *DesktopController) InspectTurn(ctx context.Context, sessionID, turnID string) (TurnObservation, error) {
	if !protocol.ValidHistoryIdentity(sessionID) || !protocol.ValidTurnID(turnID) {
		return TurnObservation{}, errors.New("invalid desktop turn identity")
	}
	p, err := d.prepareConnection(ctx, sessionID)
	if err != nil {
		return TurnObservation{}, err
	}
	defer p.Close()
	state, err := p.snapshot(ctx)
	if err != nil {
		return TurnObservation{}, err
	}
	turns, err := state.recordedTurns()
	if err != nil {
		return TurnObservation{}, err
	}
	var target *desktopControlTurn
	for _, turn := range turns {
		if turn.TurnID != turnID {
			continue
		}
		if target != nil {
			old, marshalErr := json.Marshal(target)
			if marshalErr != nil {
				return TurnObservation{}, marshalErr
			}
			current, marshalErr := json.Marshal(turn)
			if marshalErr != nil {
				return TurnObservation{}, marshalErr
			}
			if !bytes.Equal(old, current) {
				return TurnObservation{}, errors.New("conflicting exact desktop turn representations")
			}
		}
		copy := turn
		target = &copy
	}
	if target == nil {
		return TurnObservation{}, fmt.Errorf("exact desktop turn %s unavailable", turnID)
	}
	if target.Status != "inProgress" && target.Status != "completed" && target.Status != "failed" && target.Status != "interrupted" {
		return TurnObservation{}, errors.New("unknown exact desktop turn status")
	}
	status, err := normalizeTurnStatus(target.Status)
	if err != nil {
		return TurnObservation{}, err
	}
	if target.Items == nil {
		return TurnObservation{}, errors.New("desktop turn items missing")
	}
	return TurnObservation{Status: status, Output: extractTurnOutput(map[string]any{"items": target.Items}), Error: extractTurnError(status)}, nil
}
