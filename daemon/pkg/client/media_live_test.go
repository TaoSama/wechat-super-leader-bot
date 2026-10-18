package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	codexdesktop "github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/desktop"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// Exact existing target and expected hashes are supplied explicitly. This test
// only discovers its owner and reads recorded attachments; it never sends input,
// opens a journal, creates an image, or logs bodies, identities or local paths.
func TestLiveDesktopSessionMediaReadonly(t *testing.T) {
	if os.Getenv("LIVE_CODEX_DESKTOP_MEDIA") != "1" {
		t.Skip("requires LIVE_CODEX_DESKTOP_MEDIA=1 and an explicit existing target")
	}
	socketPath := os.Getenv("LIVE_CODEX_DESKTOP_SOCKET")
	sessionID := os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	expected := strings.Split(os.Getenv("LIVE_CODEX_MEDIA_EXPECT_SHA256"), ",")
	if !filepath.IsAbs(socketPath) || !protocol.ValidHistoryIdentity(sessionID) || !protocol.ValidTurnID(sessionID) || len(expected) != protocol.MaxSessionMedia {
		t.Fatal("requires explicit absolute socket, exact session and three ordered expected SHA256 values")
	}
	for _, digest := range expected {
		decoded, err := hex.DecodeString(digest)
		if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != digest {
			t.Fatal("expected SHA256 must be three canonical lowercase hashes")
		}
	}
	var adapter codex.SessionAdapter = rejectLiveNativeFallback{}
	controlPath := os.Getenv("CODEX_APP_SERVER_SOCKET")
	if controlPath != "" {
		if !filepath.IsAbs(controlPath) {
			t.Fatal("optional control socket must be absolute")
		}
		adapter = appserver.NewAppServerAdapter(controlPath)
	}
	const nodeID = "readonly-media-acceptance"
	d := NewDaemon(&config.Config{NodeID: nodeID, DesktopSocketPath: socketPath}, adapter)
	defer func() {
		d.resetMedia()
		if err := d.Close(); err != nil {
			t.Error("read-only media cleanup failed")
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if controlPath == "" {
		ownerCtx, ownerCancel := context.WithTimeout(ctx, 8*time.Second)
		updates := make(chan struct{}, 1)
		err := codexdesktop.NewDesktopObserver(socketPath).Watch(ownerCtx, []string{sessionID}, func(id string, observation protocol.DesktopObservation) {
			d.publishDesktop(id, observation, updates)
			if observation.Availability == "available" {
				ownerCancel()
			}
		})
		ownerCancel()
		if d.desktopHistorySource(sessionID) != protocol.HistorySourceDesktop {
			if err != nil {
				t.Fatal("exact read-only desktop owner discovery failed")
			}
			t.Fatal("desktop owner discovery did not establish the exact target")
		}
	}
	listing := d.ListMedia(ctx, protocol.ListMediaMessage{Type: "list_media", RequestID: "readonly-media-list", NodeID: nodeID, SessionID: sessionID})
	if listing.Error != "" {
		t.Fatalf("read-only media listing failed: %s", listing.Error)
	}
	if len(listing.Media) != protocol.MaxSessionMedia || !protocol.ValidMediaToken(listing.MediaContext) {
		t.Fatal("listing did not return exactly three bound images")
	}
	if source := os.Getenv("LIVE_CODEX_MEDIA_EXPECT_SOURCE"); source != "" && source != listing.Source {
		t.Fatal("media listing selected an unexpected source")
	}
	itemID, turnID := listing.Media[0].ItemID, listing.Media[0].TurnID
	for i, descriptor := range listing.Media {
		if descriptor.MIME != "image/jpeg" || descriptor.SHA256 != expected[i] || descriptor.ItemID != itemID || descriptor.TurnID != turnID {
			t.Fatalf("image %d does not match the ordered JPEG attachment from one native message", i+1)
		}
		bytes := make([]byte, 0, descriptor.TotalSize)
		chunks := 0
		for int64(len(bytes)) < descriptor.TotalSize {
			request := protocol.ReadMediaMessage{Type: "read_media", RequestID: "readonly-media-chunk", NodeID: nodeID, SessionID: sessionID,
				MediaContext: listing.MediaContext, MediaID: descriptor.MediaID, Offset: int64(len(bytes)), MaxBytes: protocol.MaxMediaChunkBytes}
			chunk := d.ReadMedia(ctx, request)
			if chunk.Error != "" {
				t.Fatalf("read-only image %d chunk failed: %s", i+1, chunk.Error)
			}
			if chunk.MediaContext != listing.MediaContext || chunk.MediaID != descriptor.MediaID || chunk.Offset != int64(len(bytes)) ||
				chunk.TotalSize != descriptor.TotalSize || chunk.MIME != descriptor.MIME || chunk.SHA256 != descriptor.SHA256 || len(chunk.Data) == 0 ||
				len(chunk.Data) > protocol.MaxMediaChunkBytes || chunk.EOF != (chunk.Offset+int64(len(chunk.Data)) == descriptor.TotalSize) {
				t.Fatalf("image %d chunk lost its exact attachment metadata", i+1)
			}
			bytes = append(bytes, chunk.Data...)
			chunks++
		}
		if int64(len(bytes)) != descriptor.TotalSize || mediaMIME(bytes) != "image/jpeg" {
			t.Fatalf("image %d did not reassemble to the expected JPEG size", i+1)
		}
		digest := sha256.Sum256(bytes)
		if hex.EncodeToString(digest[:]) != expected[i] {
			t.Fatalf("image %d original-byte SHA256 mismatch", i+1)
		}
		t.Logf("image=%d source=%s mime=image/jpeg bytes=%d chunks=%d expected_sha256_match=true", i+1, listing.Source, len(bytes), chunks)
	}
	if len(d.outbox) != 0 || len(d.dedupeCache) != 0 || len(d.inFlight) != 0 || d.journal != nil {
		t.Fatal("read-only image verification entered command bookkeeping")
	}
	t.Log("exact_session=true latest_single_item=true images=3 no_send=true no_journal=true")
}
