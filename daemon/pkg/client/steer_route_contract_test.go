package client

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestControllerSteerRouteContract(t *testing.T) {
	data, err := os.ReadFile("testdata/steer-route-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name      string                            `json:"name"`
		Supported bool                              `json:"supported"`
		Command   protocol.ControllerCommandMessage `json:"command"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 4 {
		t.Fatalf("expected all four send routes, got %d", len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			adapter := &steerReceiptAdapter{endpoint: cfg.SocketPath, turnID: tc.Command.ExpectedTurnID}
			d, err := OpenDaemon(cfg, adapter)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			cmd := tc.Command
			cmd.ExpiresAt = time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
			result := d.ExecuteCommand(context.Background(), cmd)
			want, calls := protocol.StatusFailed, int32(0)
			if tc.Supported {
				want, calls = protocol.StatusAccepted, 1
				if result.TurnID != cmd.ExpectedTurnID {
					t.Fatalf("lost exact turn: %+v", result)
				}
			}
			if result.Status != want || adapter.steers.Load() != calls || adapter.sends.Load() != 0 {
				t.Fatalf("route contract: result=%+v steers=%d starts=%d", result, adapter.steers.Load(), adapter.sends.Load())
			}
			if replay := d.ExecuteCommand(context.Background(), cmd); !protocol.SameResult(replay, result) || adapter.steers.Load() != calls {
				t.Fatalf("replay changed receipt or repeated input: %+v", replay)
			}
		})
	}
}
