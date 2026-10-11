package codex

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const DesktopWatchWindow = 30 * time.Second
const desktopUnsubscribeTimeout = 200 * time.Millisecond
const maxDesktopRevision = 1<<53 - 1

type DesktopWatcher interface {
	Watch(context.Context, []string, func(string, protocol.DesktopObservation)) error
}

type DesktopObserver struct {
	socketPath         string
	ownerTimeout       time.Duration
	watchWindow        time.Duration
	discovery          desktopDiscoverySchedule
	subscriptionWindow time.Duration
	subscriptionLimit  int
	frameBudget        *desktopFrameBudget
	subscriptions      desktopDiscoverySchedule
}

func NewDesktopObserver(socketPath string) *DesktopObserver {
	return &DesktopObserver{socketPath: socketPath, ownerTimeout: desktopOwnerTimeout, watchWindow: DesktopWatchWindow,
		subscriptionWindow: desktopSubscriptionWindow, subscriptionLimit: desktopSubscriptionConcurrency,
		frameBudget: newDesktopFrameBudget(desktopFrameConcurrency, desktopFrameBodyTimeout)}
}

type desktopRuntimeState struct {
	ID                      string          `json:"id"`
	HostID                  string          `json:"hostId"`
	ThreadRuntimeStatus     json.RawMessage `json:"threadRuntimeStatus"`
	LatestModel             json.RawMessage `json:"-"`
	LatestReasoningEffort   json.RawMessage `json:"-"`
	ModelProvider           json.RawMessage `json:"-"`
	LatestCollaborationMode json.RawMessage `json:"-"`
}

type desktopPatch struct {
	Op    string          `json:"op"`
	Path  []any           `json:"path"`
	Value json.RawMessage `json:"value"`
}

type desktopChangeParams struct {
	ConversationID string `json:"conversationId"`
	HostID         string `json:"hostId"`
	Change         struct {
		Type              string               `json:"type"`
		Revision          *uint64              `json:"revision"`
		BaseRevision      *uint64              `json:"baseRevision"`
		ConversationState *desktopRuntimeState `json:"conversationState"`
		Patches           []desktopPatch       `json:"patches"`
	} `json:"change"`
}

type desktopProjection struct {
	owner                string
	revision             uint64
	initialized          bool
	status               string
	latestModel          string
	collaborationModel   string
	collaborationNullish bool
	modelProvider        string
	reasoningEffort      string
}

func desktopStatus(raw json.RawMessage) string {
	var status struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return "unknown"
	}
	if status.Type == "active" || status.Type == "idle" {
		return status.Type
	}
	return "unknown"
}

func (p *desktopProjection) snapshot(sessionID string, state *desktopRuntimeState) error {
	if state == nil || state.ID != sessionID || state.HostID != "local" {
		return errors.New("desktop snapshot identity mismatch")
	}
	p.status = desktopStatus(state.ThreadRuntimeStatus)
	p.latestModel = desktopModelString(state.LatestModel)
	p.modelProvider = desktopModelString(state.ModelProvider)
	p.reasoningEffort = desktopModelString(state.LatestReasoningEffort)
	p.collaborationModel, p.collaborationNullish = desktopCollaborationModel(state.LatestCollaborationMode)
	return nil
}

func (p *desktopProjection) patch(sessionID string, patch desktopPatch) error {
	if patch.Op != "add" && patch.Op != "replace" && patch.Op != "remove" {
		return errors.New("unsupported desktop patch operation")
	}
	if patch.Path == nil || (patch.Op != "remove" && len(patch.Value) == 0) {
		return errors.New("desktop patch path or value missing")
	}
	for _, part := range patch.Path {
		switch value := part.(type) {
		case string:
		case float64:
			if value < 0 || value > maxDesktopRevision || math.Trunc(value) != value {
				return errors.New("invalid desktop patch index")
			}
		default:
			return errors.New("invalid desktop patch path segment")
		}
	}
	if len(patch.Path) == 0 {
		var state desktopRuntimeState
		if patch.Op == "remove" || json.Unmarshal(patch.Value, &state) != nil {
			return errors.New("invalid desktop root patch")
		}
		return p.snapshot(sessionID, &state)
	}
	key, ok := patch.Path[0].(string)
	if !ok {
		return errors.New("invalid desktop patch path")
	}
	if key == "id" || key == "hostId" {
		return errors.New("desktop patch changes target identity")
	}
	if p.patchModel(patch, key) {
		return nil
	}
	if key != "threadRuntimeStatus" {
		return nil
	}
	if len(patch.Path) == 1 {
		p.status = desktopStatus(patch.Value)
		if patch.Op == "remove" {
			p.status = "unknown"
		}
		return nil
	}
	if patch.Path[1] != "type" {
		return nil
	}
	if len(patch.Path) != 2 {
		return errors.New("invalid desktop status patch path")
	}
	var status string
	if patch.Op == "remove" || json.Unmarshal(patch.Value, &status) != nil {
		p.status = "unknown"
		return nil
	}
	p.status = "unknown"
	if status == "active" || status == "idle" {
		p.status = status
	}
	return nil
}

func applyDesktopChange(message desktopEnvelope, clientID string, projections map[string]*desktopProjection, publish func(string, protocol.DesktopObservation)) error {
	if message.Type != "broadcast" || message.Method != desktopStateChanged {
		return nil
	}
	targeted := false
	for _, target := range message.TargetClientIDs {
		if target == clientID {
			targeted = true
		}
	}
	if !targeted {
		return nil
	}
	var params desktopChangeParams
	if message.Version != 11 || json.Unmarshal(message.Params, &params) != nil || params.HostID != "local" {
		return errors.New("invalid desktop state envelope")
	}
	projection, ok := projections[params.ConversationID]
	if !ok || projection.owner != message.SourceClientID {
		return errors.New("desktop state owner mismatch")
	}
	change := params.Change
	if change.Revision == nil || *change.Revision > maxDesktopRevision {
		return errors.New("desktop state revision missing")
	}
	switch change.Type {
	case "snapshot":
		if projection.initialized && *change.Revision < projection.revision {
			return errors.New("desktop snapshot revision regressed")
		}
		if err := projection.snapshot(params.ConversationID, change.ConversationState); err != nil {
			return err
		}
	case "patches":
		if !projection.initialized || change.BaseRevision == nil || *change.BaseRevision != projection.revision || *change.Revision <= projection.revision {
			return errors.New("desktop state revision gap")
		}
		for _, patch := range change.Patches {
			if err := projection.patch(params.ConversationID, patch); err != nil {
				return err
			}
		}
	default:
		return errors.New("unsupported desktop state change")
	}
	projection.revision, projection.initialized = *change.Revision, true
	model, provider, effort := projection.modelMetadata()
	publish(params.ConversationID, protocol.DesktopObservation{Status: projection.status, Availability: "available", Source: "codex-desktop", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), OwnerID: projection.owner, Revision: projection.revision,
		Model: model, ModelProvider: provider, ReasoningEffort: effort})
	return nil
}

// Watch discovers owners together but isolates each bounded state subscription.
// Only scalar execution-state projections enter public telemetry.
func (o *DesktopObserver) Watch(ctx context.Context, ids []string, publish func(string, protocol.DesktopObservation)) (err error) {
	return o.watchSubscriptions(ctx, ids, publish)
}

func (o *DesktopObserver) Snapshot(ctx context.Context, ids []string, publish func(string, protocol.DesktopObservation)) error {
	return o.watch(ctx, ids, publish, true)
}
