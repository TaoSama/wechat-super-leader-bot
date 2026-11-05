package appserver_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

// approvalFixture replays pending server requests after thread/resume, the way
// app-server does for a newly subscribed connection, and records any answers.
type approvalFixture struct {
	mu          sync.Mutex
	loaded      bool
	resolve     bool
	requests    []map[string]any
	answers     []map[string]any
	resumeCalls int
}

func (f *approvalFixture) serve(t *testing.T) (string, func()) {
	return fakeAppServer(t, func(conn *websocket.Conn) {
		for {
			var message map[string]any
			if err := conn.ReadJSON(&message); err != nil {
				return
			}
			method, _ := message["method"].(string)
			if method == "" {
				f.mu.Lock()
				f.answers = append(f.answers, message)
				resolve := f.resolve
				f.mu.Unlock()
				if resolve {
					_ = conn.WriteJSON(map[string]any{"method": "serverRequest/resolved",
						"params": map[string]any{"threadId": "session", "requestId": message["id"]}})
				}
				continue
			}
			var result any
			switch method {
			case "initialize":
				result = map[string]any{}
			case "initialized":
				continue
			case "thread/loaded/list":
				data := []string{}
				if f.loaded {
					data = append(data, "session")
				}
				result = map[string]any{"data": data}
			case "thread/resume":
				f.mu.Lock()
				f.resumeCalls++
				f.mu.Unlock()
				result = map[string]any{"thread": map[string]any{"id": "session",
					"status": map[string]any{"type": "active", "activeFlags": []any{"waitingOnApproval"}}}}
			default:
				t.Errorf("unexpected RPC: %s", method)
				return
			}
			if err := conn.WriteJSON(map[string]any{"id": message["id"], "result": result}); err != nil {
				return
			}
			if method == "thread/resume" {
				for _, request := range f.requests {
					_ = conn.WriteJSON(request)
				}
			}
		}
	})
}

func commandApprovalRequest(id any, threadID, turnID string) map[string]any {
	return map[string]any{"id": id, "method": "item/commandExecution/requestApproval", "params": map[string]any{
		"threadId": threadID, "turnId": turnID, "itemId": "item-1", "startedAtMs": 1767225600000,
		"command": "rm -rf build\n\x1b[31m", "cwd": "/repo", "reason": "needs write access"}}
}

func TestPendingApprovalsObservesReplayWithoutAnswering(t *testing.T) {
	f := &approvalFixture{loaded: true, requests: []map[string]any{
		commandApprovalRequest(7, "session", "turn-1"),
		commandApprovalRequest(8, "other-session", "turn-1"),
		{"id": "req-9", "method": "item/fileChange/requestApproval", "params": map[string]any{
			"threadId": "session", "turnId": "turn-1", "itemId": "item-2", "startedAtMs": 1767225600000, "reason": nil, "grantRoot": "/repo/src"}},
		{"id": 10, "method": "item/tool/requestUserInput", "params": map[string]any{"threadId": "session", "turnId": "turn-1", "itemId": "item-3"}},
	}}
	path, cleanup := f.serve(t)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	approvals, err := appserver.NewAppServerAdapter(path).PendingApprovals(ctx, "session")
	if err != nil {
		t.Fatal(err)
	}
	if len(approvals) != 3 {
		t.Fatalf("approvals = %+v", approvals)
	}
	command := approvals[0]
	if command.RequestID != "7" || command.Kind != protocol.ApprovalKindCommand || command.TurnID != "turn-1" ||
		command.Command != "rm -rf build  [31m" || command.Cwd != "/repo" || !command.Answerable || command.StartedAt == "" {
		t.Fatalf("command approval = %+v", command)
	}
	if file := approvals[1]; file.RequestID != "req-9" || file.Kind != protocol.ApprovalKindFileChange || file.GrantRoot != "/repo/src" || !file.Answerable {
		t.Fatalf("file approval = %+v", file)
	}
	if input := approvals[2]; input.Kind != protocol.ApprovalKindUserInput || input.Answerable {
		t.Fatalf("user input = %+v", input)
	}
	time.Sleep(50 * time.Millisecond)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.answers) != 0 {
		t.Fatalf("observation answered requests: %+v", f.answers)
	}
}

func TestPendingApprovalsNeverResumesUnloadedThread(t *testing.T) {
	f := &approvalFixture{loaded: false}
	path, cleanup := f.serve(t)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	adapter := appserver.NewAppServerAdapter(path)
	if _, err := adapter.PendingApprovals(ctx, "session"); !errors.Is(err, codex.ErrApprovalUnreachable) {
		t.Fatalf("err = %v", err)
	}
	if err := adapter.AnswerApproval(ctx, "session", "turn-1", "7", protocol.ApprovalAccept); !errors.Is(err, codex.ErrApprovalUnreachable) {
		t.Fatalf("answer err = %v", err)
	}
	if f.resumeCalls != 0 {
		t.Fatal("unloaded thread was resumed")
	}
}

func TestAnswerApprovalFlow(t *testing.T) {
	for _, tc := range []struct {
		name, turnID, requestID, decision string
		resolve                           bool
		wantAnswers                       int
		check                             func(error) bool
	}{
		{"resolved", "turn-1", "7", protocol.ApprovalAccept, true, 1, func(err error) bool { return err == nil }},
		{"decline", "turn-1", "7", protocol.ApprovalDecline, true, 1, func(err error) bool { return err == nil }},
		{"timeout-uncertain", "turn-1", "7", protocol.ApprovalAccept, false, 1, codex.IsUncertain},
		{"mismatched-request", "turn-1", "99", protocol.ApprovalAccept, true, 0,
			func(err error) bool { return errors.Is(err, codex.ErrApprovalNotPending) }},
		{"mismatched-turn", "turn-2", "7", protocol.ApprovalAccept, true, 0,
			func(err error) bool { return err != nil && !codex.IsUncertain(err) }},
		{"session-wide-rejected", "turn-1", "7", "acceptForSession", true, 0,
			func(err error) bool { return err != nil && !codex.IsUncertain(err) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &approvalFixture{loaded: true, resolve: tc.resolve, requests: []map[string]any{commandApprovalRequest(7, "session", "turn-1")}}
			path, cleanup := f.serve(t)
			defer cleanup()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			err := appserver.NewAppServerAdapter(path).AnswerApproval(ctx, "session", tc.turnID, tc.requestID, tc.decision)
			if !tc.check(err) {
				t.Fatalf("err = %v", err)
			}
			time.Sleep(50 * time.Millisecond)
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.answers) != tc.wantAnswers {
				t.Fatalf("answers = %+v", f.answers)
			}
			if tc.wantAnswers == 1 {
				encoded, _ := json.Marshal(f.answers[0])
				want := `{"id":7,"jsonrpc":"2.0","result":{"decision":"` + tc.decision + `"}}`
				if string(encoded) != want {
					t.Fatalf("answer = %s, want %s", encoded, want)
				}
			}
		})
	}
}
