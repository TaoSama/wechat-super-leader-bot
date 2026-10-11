package client

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type sendReceiptAdapter struct {
	ack   string
	sends atomic.Int32
}

func (a *sendReceiptAdapter) DiscoverSessions(context.Context) ([]protocol.Session, error) {
	return nil, nil
}
func (a *sendReceiptAdapter) ReadSession(context.Context, string) (string, error) { return "", nil }
func (a *sendReceiptAdapter) SendPrompt(context.Context, string, string) (string, error) {
	a.sends.Add(1)
	return a.ack, nil
}

func TestAdapterAcknowledgementMustBindExactValidTurn(t *testing.T) {
	for _, tc := range []struct {
		name, ack string
		valid     bool
	}{
		{"missing", "", false}, {"unknown-receipt", "PRIVATE_SECRET=/private/path", false},
		{"blank", "turnId=", false}, {"leading", "turnId= target", false}, {"trailing", "turnId=target ", false},
		{"space", "turnId=one two", false}, {"tab", "turnId=one\ttwo", false}, {"newline", "turnId=one\ntwo", false},
		{"unicode-space", "turnId=one\u2003two", false}, {"nul", "turnId=one\x00two", false},
		{"control", "turnId=one\x01two", false}, {"delete", "turnId=one\x7ftwo", false},
		{"replacement-character", "turnId=one\ufffdtwo", false},
		{"overlong", "turnId=" + strings.Repeat("a", protocol.MaxTurnIDLength+1), false},
		{"secret-malformed", "turnId=PRIVATE_SECRET\n/private/path", false},
		{"valid", "turnId=target", true}, {"maximum", "turnId=" + strings.Repeat("a", protocol.MaxTurnIDLength), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			adapter := &sendReceiptAdapter{ack: tc.ack}
			d := NewDaemon(&config.Config{NodeID: "demoair"}, adapter)
			cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
			result := d.ExecuteCommand(context.Background(), cmd)
			if tc.valid {
				if result.Status != protocol.StatusAccepted || result.TurnID != strings.TrimPrefix(tc.ack, "turnId=") || result.Output != tc.ack || result.Error != "" {
					t.Fatal("valid receipt lost its exact turn binding")
				}
			} else if result.Status != protocol.StatusUncertain || result.TurnID != "" || result.Output != "" || result.Error != protocol.InvalidTurnAcknowledgement {
				t.Fatalf("malformed acknowledgement was accepted or leaked: status=%s turnBytes=%d outputBytes=%d", result.Status, len(result.TurnID), len(result.Output))
			}
			if replay := d.ExecuteCommand(context.Background(), cmd); replay != result || adapter.sends.Load() != 1 {
				t.Fatal("duplicate receipt dispatched another turn")
			}
		})
	}
}

func TestDurableMalformedAcknowledgementStaysUncertainAfterRestart(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	adapter := &sendReceiptAdapter{ack: "turnId=PRIVATE_SECRET\n/private/path"}
	d, err := OpenDaemon(cfg, adapter)
	if err != nil {
		t.Fatal(err)
	}
	cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	result := d.ExecuteCommand(context.Background(), cmd)
	if result.Status != protocol.StatusUncertain || result.Error != protocol.InvalidTurnAcknowledgement || result.Output != "" || result.TurnID != "" {
		t.Fatal("invalid acknowledgement was not sanitized before persistence")
	}
	if duplicate := d.ExecuteCommand(context.Background(), cmd); duplicate != result || adapter.sends.Load() != 1 {
		t.Fatal("durable duplicate dispatched twice")
	}
	closeDaemon(t, d)

	// Reopen the same on-disk journal, retaining its scope and replay protection.
	restarted := &sendReceiptAdapter{ack: "turnId=should-never-dispatch"}
	d, err = OpenDaemon(cfg, restarted)
	if err != nil {
		t.Fatal(err)
	}
	if recovered := d.ExecuteCommand(context.Background(), cmd); recovered != result || restarted.sends.Load() != 0 {
		t.Fatal("restart lost the uncertain receipt or redispatched")
	}
	var outbox []protocol.DaemonResultMessage
	if err := d.flushResults(func(message any) error { outbox = append(outbox, message.(protocol.DaemonResultMessage)); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(outbox) != 1 || outbox[0] != result {
		t.Fatal("uncertain receipt was not preserved in the durable outbox")
	}
	if err := d.ackResult(protocol.ResultAckMessage{Type: "result_ack", CommandID: result.CommandID, Status: result.Status}); err != nil {
		t.Fatal(err)
	}
	closeDaemon(t, d)
	d, err = OpenDaemon(cfg, restarted)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	if recovered := d.ExecuteCommand(context.Background(), cmd); recovered.Status != protocol.StatusUncertain || recovered.CommandID != result.CommandID || recovered.TurnID != "" || recovered.Output != "" || restarted.sends.Load() != 0 {
		t.Fatal("ack erased durable replay protection")
	}
	if pending, err := d.journal.Unacked(); err != nil || len(pending) != 0 {
		t.Fatal("uncertain acknowledgement was not persisted")
	}
}
