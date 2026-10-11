package client

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// This opt-in test is a real mutation of an explicitly selected test thread.
// Keep its command ID, expiry, and durable state directory together. Rerunning
// the same fixture inspects/replays its receipt; it never retries a lost send.
func TestLiveDesktopOwnerSend(t *testing.T) {
	if os.Getenv("LIVE_DESKTOP_SEND") != "fixture-only" {
		t.Skip("requires explicit fixture-only opt-in and a reusable desktop test thread")
	}
	required := func(name string) string {
		t.Helper()
		value := os.Getenv(name)
		if value == "" {
			t.Fatalf("missing %s; do not invent a new command ID to retry an uncertain send", name)
		}
		return value
	}
	sessionID := required("LIVE_DESKTOP_SESSION")
	commandID := required("LIVE_DESKTOP_COMMAND_ID")
	expiry := required("LIVE_DESKTOP_EXPIRES_AT")
	stateDir := required("LIVE_DESKTOP_STATE_DIR")
	socketPath := required("LIVE_DESKTOP_SOCKET")
	if !protocol.ValidHistoryIdentity(sessionID) || !protocol.ValidHistoryIdentity(commandID) ||
		!filepath.IsAbs(stateDir) || !filepath.IsAbs(socketPath) {
		t.Fatal("explicit valid fixture identities and absolute paths are required")
	}
	if _, err := time.Parse(time.RFC3339Nano, expiry); err != nil {
		t.Fatal(err)
	}
	const testNode = "desktop-owner-acceptance"
	cfg := &config.Config{NodeID: testNode, ControllerURL: "ws://127.0.0.1:1/acceptance",
		SocketPath: "/desktop-owner-acceptance/native-disabled", DesktopSocketPath: socketPath, DesktopSend: true, StateDir: stateDir}
	marker := "DESKTOP_OWNER_VERIFIED_" + commandID
	cmd := protocol.ControllerCommandMessage{Type: "command", CommandID: commandID, NodeID: testNode,
		SessionID: sessionID, Action: protocol.ActionSend, SendRoute: protocol.RouteDesktopOwner,
		Prompt: "原桌面会话控制通道验收。请只回复 " + marker + "。不要调用工具，不要修改文件或配置，不要发送其他消息。", ExpiresAt: expiry}
	d, err := OpenDaemon(cfg, rejectLiveNativeFallback{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if d != nil {
			if err := d.Close(); err != nil {
				t.Error(err)
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	result := d.ExecuteCommand(ctx, cmd)
	t.Logf("desktop command=%s session=%s status=%s turn=%s error=%s", commandID, sessionID, result.Status, result.TurnID, result.Error)
	if result.Status != protocol.StatusAccepted || !protocol.ValidTurnID(result.TurnID) {
		t.Fatal("no exact accepted turn; preserve this journal and do not resend")
	}
	if replay := d.ExecuteCommand(ctx, cmd); replay != result {
		t.Fatalf("duplicate command changed receipt: %+v", replay)
	}
	if err := d.ackResult(protocol.ResultAckMessage{Type: "result_ack", CommandID: commandID,
		TurnID: result.TurnID, Status: result.Status}); err != nil {
		t.Fatal(err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	d = nil
	d, err = OpenDaemon(cfg, rejectLiveNativeFallback{})
	if err != nil {
		t.Fatal(err)
	}
	// ACK intentionally discards bulky output, but keeps the exact receipt
	// identity and replay guard across process restarts.
	if replay := d.ExecuteCommand(ctx, cmd); replay.CommandID != result.CommandID || replay.Status != result.Status || replay.TurnID != result.TurnID {
		t.Fatalf("ACK/restart changed receipt: %+v", replay)
	}
	inspection := protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: commandID,
		NodeID: testNode, SessionID: sessionID, TurnID: result.TurnID}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		observed := d.InspectTurn(ctx, inspection)
		switch observed.Status {
		case protocol.StatusCompleted:
			if strings.TrimSpace(observed.Output) != marker {
				t.Fatalf("exact completed turn output did not match marker: %+v", observed)
			}
			t.Logf("exact desktop turn=%s completed; output=%s; duplicate and ACK/restart replay preserved", observed.TurnID, observed.Output)
			return
		case protocol.StatusFailed:
			t.Fatalf("exact turn failed: %+v", observed)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("exact-turn observation timed out: %+v; preserve journal; do not resend", observed)
		case <-ticker.C:
		}
	}
}

type rejectLiveNativeFallback struct{}

func (rejectLiveNativeFallback) DiscoverSessions(context.Context) ([]protocol.Session, error) {
	return nil, errors.New("live desktop fixture cannot discover via native fallback")
}
func (rejectLiveNativeFallback) ReadSession(context.Context, string) (string, error) {
	return "", errors.New("live desktop fixture cannot read via native fallback")
}
func (rejectLiveNativeFallback) SendPrompt(context.Context, string, string) (string, error) {
	return "", errors.New("live desktop fixture cannot send via native fallback")
}

var _ codex.SessionAdapter = rejectLiveNativeFallback{}
