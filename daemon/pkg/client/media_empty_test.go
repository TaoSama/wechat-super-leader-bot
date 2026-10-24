package client

import (
	"context"
	"errors"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type emptyMediaValidationFixture struct {
	mediaFixture
	validationErr error
	validations   int
}

func (f *emptyMediaValidationFixture) ValidateMediaGeneration(ctx context.Context, sessionID, generation string) error {
	f.validations++
	if f.validationErr != nil {
		return f.validationErr
	}
	return f.mediaFixture.ValidateMediaGeneration(ctx, sessionID, generation)
}

func TestEmptyMediaListStillValidatesGeneration(t *testing.T) {
	for _, test := range []struct {
		name          string
		validationErr error
		wantError     string
	}{
		{name: "current"},
		{name: "expired", validationErr: errors.New(protocol.MediaContextExpired), wantError: protocol.MediaContextExpired},
		{name: "cancelled", validationErr: context.Canceled, wantError: protocol.MediaTimeout},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := &emptyMediaValidationFixture{mediaFixture: mediaFixture{generation: "owner"}, validationErr: test.validationErr}
			d := NewDaemon(&config.Config{NodeID: "node"}, fixture)
			response := d.ListMedia(context.Background(), protocol.ListMediaMessage{Type: "list_media", RequestID: "empty-list", NodeID: "node", SessionID: "session"})
			if fixture.validations != 1 || response.Error != test.wantError {
				t.Fatalf("empty list bypassed generation validation: calls=%d response=%+v", fixture.validations, response)
			}
			if response.Type != "media_list" || response.RequestID != "empty-list" || response.SessionID != "session" || len(response.Media) != 0 {
				t.Fatalf("empty list changed response identity: %+v", response)
			}
			if test.wantError == "" {
				if !protocol.ValidMediaToken(response.MediaContext) || response.Source != protocol.HistorySourceControl {
					t.Fatalf("empty list lost its protocol context and source: %+v", response)
				}
			} else if response.MediaContext != "" {
				t.Fatalf("invalid generation published a media context: %+v", response)
			}
			if len(d.mediaState.bindings) != 0 {
				t.Fatal("empty list retained an unreadable media binding")
			}
		})
	}
}
