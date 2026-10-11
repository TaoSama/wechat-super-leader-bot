package protocol

import (
	"regexp"
	"testing"
	"time"
)

func TestDispatchIDsAndRouteIdentity(t *testing.T) {
	pattern := regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
	seen := map[string]bool{}
	for range 100 {
		id, err := NewDispatchID()
		if err != nil || !pattern.MatchString(id) || seen[id] {
			t.Fatalf("invalid dispatch UUID: %q %v", id, err)
		}
		seen[id] = true
	}
	cmd := ControllerCommandMessage{Type: "command", CommandID: "command", NodeID: "node", SessionID: "session", Action: ActionSend, Prompt: "test", ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}
	defaultFingerprint := cmd.PayloadFingerprint()
	cmd.SendRoute = RouteDesktopOwner
	if err := cmd.Validate("node", time.Now()); err != nil {
		t.Fatal(err)
	}
	if defaultFingerprint == cmd.PayloadFingerprint() {
		t.Fatal("route absent from command identity")
	}
	cmd.Action = ActionRead
	if cmd.Validate("node", time.Now()) == nil {
		t.Fatal("read accepted send route")
	}
	cmd.Action, cmd.SendRoute = ActionSend, "unknown"
	if cmd.Validate("node", time.Now()) == nil {
		t.Fatal("unknown send route accepted")
	}
}
