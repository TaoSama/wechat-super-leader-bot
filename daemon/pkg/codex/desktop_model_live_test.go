package codex

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const liveDesktopModelTimeout = 10 * time.Second

// Opt-in only: read the existing owner's settings and compare its stream
// projection. No preflight, history loading, resume or turn start is performed.
func TestLiveCodexDesktopReadonlyModelObservation(t *testing.T) {
	path, sessionID := os.Getenv("LIVE_CODEX_DESKTOP_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	if path == "" || sessionID == "" {
		t.Skip("requires explicit LIVE_CODEX_DESKTOP_SOCKET and LIVE_CODEX_DESKTOP_SESSION")
	}
	if !protocol.ValidHistoryIdentity(sessionID) {
		t.Fatal("invalid readonly session identity")
	}
	ctx, cancel := context.WithTimeout(context.Background(), liveDesktopModelTimeout)
	defer cancel()
	p, err := NewDesktopController(path).prepareConnection(ctx, sessionID)
	if err != nil {
		t.Fatal("readonly model owner discovery failed")
	}
	defer p.Close()
	requestID, err := protocol.NewDispatchID()
	if err != nil {
		t.Fatal("readonly request identity generation failed")
	}
	response, _, err := p.targeted(ctx, desktopReadSettings, 1, requestID, map[string]string{"conversationId": sessionID})
	if err != nil {
		t.Fatal("readonly owner model settings request failed")
	}
	var result struct {
		Settings *struct {
			Model           string  `json:"model"`
			ModelProvider   *string `json:"modelProvider"`
			ReasoningEffort *string `json:"reasoningEffort"`
		} `json:"settings"`
	}
	if json.Unmarshal(response.Result, &result) != nil || result.Settings == nil || result.Settings.Model == "" {
		t.Fatal("readonly owner model settings missing or malformed")
	}
	ownerID := p.identity.OwnerID
	p.Close()
	provider, effort := "", ""
	if result.Settings.ModelProvider != nil {
		provider = *result.Settings.ModelProvider
	}
	if result.Settings.ReasoningEffort != nil {
		effort = *result.Settings.ReasoningEffort
	}
	var observations []protocol.DesktopObservation
	err = NewDesktopObserver(path).Snapshot(ctx, []string{sessionID}, func(id string, o protocol.DesktopObservation) {
		if id != sessionID || o.OwnerID != ownerID {
			t.Error("readonly snapshot changed session or owner identity")
		}
		observations = append(observations, o)
	})
	if err != nil {
		t.Fatal("readonly model snapshot failed")
	}
	if len(observations) != 1 {
		t.Fatal("readonly model snapshot did not return one exact observation")
	}
	o := observations[0]
	if o.Source != "codex-desktop" || o.Availability != "available" || o.Model == "" {
		t.Fatal("readonly model observation unavailable")
	}
	if o.Model != result.Settings.Model || o.ModelProvider != provider || o.ReasoningEffort != effort {
		t.Fatalf("model metadata mismatch: settings model=%q provider=%q effort=%q; observation model=%q provider=%q effort=%q status=%q",
			result.Settings.Model, provider, effort, o.Model, o.ModelProvider, o.ReasoningEffort, o.Status)
	}
	t.Logf("readonly model observation: model=%q provider=%q effort=%q status=%q", o.Model, o.ModelProvider, o.ReasoningEffort, o.Status)
}
