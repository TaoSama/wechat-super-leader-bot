package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type mediaFixture struct {
	refs       []protocol.NativeMediaReference
	generation string
	listErr    error
}

func (f *mediaFixture) DiscoverSessions(context.Context) ([]protocol.Session, error) { return nil, nil }
func (f *mediaFixture) ReadSession(context.Context, string) (string, error) {
	return "", errors.New("unused")
}
func (f *mediaFixture) SendPrompt(context.Context, string, string) (string, error) {
	return "", errors.New("unused")
}
func (f *mediaFixture) ListSessionMedia(ctx context.Context, _, generation, itemID, turnID string, limit int) ([]protocol.NativeMediaReference, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	return f.refs, f.generation, f.listErr
}
func (f *mediaFixture) ValidateMediaGeneration(ctx context.Context, _, generation string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if generation != f.generation {
		return errors.New(protocol.MediaContextExpired)
	}
	return nil
}

func mediaFixturePath(t *testing.T) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(directory, "image.png")
}

func mediaPNG(t *testing.T, path string, length int) []byte {
	t.Helper()
	data := bytes.Repeat([]byte{41}, length)
	copy(data, []byte{137, 80, 78, 71, 13, 10, 26, 10})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return data
}

func mediaFixtureDaemon(t *testing.T, path string) (*Daemon, *mediaFixture, protocol.DaemonMediaListMessage) {
	t.Helper()
	f := &mediaFixture{generation: "owner-1", refs: []protocol.NativeMediaReference{{ItemID: "item", TurnID: "turn", Path: path}}}
	d := NewDaemon(&config.Config{NodeID: "node"}, f)
	listed := d.ListMedia(context.Background(), protocol.ListMediaMessage{Type: "list_media", RequestID: "list", NodeID: "node", SessionID: "session"})
	if listed.Error != "" || len(listed.Media) != 1 {
		t.Fatalf("list failed %+v", listed)
	}
	return d, f, listed
}

func mediaReadRequest(list protocol.DaemonMediaListMessage) protocol.ReadMediaMessage {
	return protocol.ReadMediaMessage{Type: "read_media", RequestID: "read", NodeID: "node", SessionID: "session", MediaContext: list.MediaContext, MediaID: list.Media[0].MediaID, MaxBytes: protocol.MaxMediaChunkBytes}
}

func TestMediaChunksAreBoundedAndReassembleWithFixedMetadata(t *testing.T) {
	path := mediaFixturePath(t)
	want := mediaPNG(t, path, protocol.MaxMediaChunkBytes*2+17)
	d, _, list := mediaFixtureDaemon(t, path)
	request := mediaReadRequest(list)
	got := []byte{}
	for {
		response := d.ReadMedia(context.Background(), request)
		if response.Error != "" {
			t.Fatal(response.Error)
		}
		if response.Offset != int64(len(got)) || len(response.Data) > protocol.MaxMediaChunkBytes || response.TotalSize != int64(len(want)) || response.SHA256 != list.Media[0].SHA256 || response.MIME != "image/png" {
			t.Fatalf("invalid chunk metadata %+v", response)
		}
		encoded, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		if len(encoded) >= protocol.MaxHistoryResponseBytes || strings.Contains(string(encoded), path) {
			t.Fatal("wire frame leaked path or exceeded limit")
		}
		got = append(got, response.Data...)
		if response.EOF {
			break
		}
		request.Offset = int64(len(got))
	}
	if !bytes.Equal(got, want) {
		t.Fatal("chunks did not reassemble original bytes")
	}
}

func TestMediaListPreservesSafeOriginalImagePositions(t *testing.T) {
	const maxSafeOrdinal int64 = 1<<53 - 1
	path := mediaFixturePath(t)
	mediaPNG(t, path, 32)
	for _, tc := range []struct {
		name     string
		ordinals []int64
		invalid  bool
	}{
		{name: "sparse-positions", ordinals: []int64{255, 256, 258}},
		{name: "maximum-safe-position", ordinals: []int64{maxSafeOrdinal}},
		{name: "negative-position", ordinals: []int64{-1}, invalid: true},
		{name: "unsafe-position", ordinals: []int64{maxSafeOrdinal + 1}, invalid: true},
		{name: "too-many-attachments", ordinals: []int64{256, 257, 258, 259}, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			refs := make([]protocol.NativeMediaReference, 0, len(tc.ordinals))
			for _, ordinal := range tc.ordinals {
				if int64(int(ordinal)) != ordinal {
					t.Skip("ordinal exceeds platform int range")
				}
				refs = append(refs, protocol.NativeMediaReference{ItemID: "item", TurnID: "turn", Ordinal: int(ordinal), Path: path})
			}
			fixture := &mediaFixture{generation: "owner", refs: refs}
			d := NewDaemon(&config.Config{NodeID: "node"}, fixture)
			listed := d.ListMedia(context.Background(), protocol.ListMediaMessage{Type: "list_media", RequestID: "list", NodeID: "node", SessionID: "session"})
			if tc.invalid {
				if listed.Error != protocol.MediaFailed || len(listed.Media) != 0 || listed.MediaContext != "" {
					t.Fatalf("invalid original positions published: %+v", listed)
				}
				return
			}
			if listed.Error != "" || len(listed.Media) != len(tc.ordinals) {
				t.Fatalf("safe original positions rejected: %+v", listed)
			}
			for i, descriptor := range listed.Media {
				if int64(descriptor.Ordinal) != tc.ordinals[i] {
					t.Fatalf("original position or order changed: %+v", listed.Media)
				}
			}
		})
	}
}

func TestMediaRejectsCrossSessionContextMediaAndExpiredOwner(t *testing.T) {
	path := mediaFixturePath(t)
	mediaPNG(t, path, 32)
	d, fixture, list := mediaFixtureDaemon(t, path)
	request := mediaReadRequest(list)
	for _, mutate := range []func(*protocol.ReadMediaMessage){
		func(m *protocol.ReadMediaMessage) { m.SessionID = "other" },
		func(m *protocol.ReadMediaMessage) { m.NodeID = "other" },
		func(m *protocol.ReadMediaMessage) { m.MediaID = "11111111-1111-4111-8111-111111111111" },
		func(m *protocol.ReadMediaMessage) { m.MediaContext = "11111111-1111-4111-8111-111111111111" },
		func(m *protocol.ReadMediaMessage) { m.MaxBytes = protocol.MaxMediaChunkBytes + 1 },
		func(m *protocol.ReadMediaMessage) { m.Offset = -1 },
	} {
		bad := request
		mutate(&bad)
		if got := d.ReadMedia(context.Background(), bad); got.Error == "" || len(got.Data) != 0 {
			t.Fatal("accepted invalid binding")
		}
	}
	fixture.generation = "owner-2"
	if got := d.ReadMedia(context.Background(), request); got.Error != protocol.MediaContextExpired {
		t.Fatal("owner changed without expiration")
	}
	fixture.generation = "owner-1"
	d.resetMedia()
	if got := d.ReadMedia(context.Background(), request); got.Error != protocol.MediaContextExpired {
		t.Fatal("disconnect retained media binding")
	}
}

func TestMediaRejectsMutationEvenIfSizeAndModtimeAreRestored(t *testing.T) {
	path := mediaFixturePath(t)
	data := mediaPNG(t, path, 32)
	d, _, list := mediaFixtureDaemon(t, path)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)-1]++
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if got := d.ReadMedia(context.Background(), mediaReadRequest(list)); got.Error != protocol.MediaContextExpired || len(got.Data) != 0 {
		t.Fatal("changed image escaped checksum validation")
	}
}

func TestMediaRejectsSymlinksDirectoriesOversizeAndSVG(t *testing.T) {
	path := mediaFixturePath(t)
	mediaPNG(t, path, 32)
	for _, name := range []string{"symlink", "parent-symlink", "directory", "oversize", "svg"} {
		t.Run(name, func(t *testing.T) {
			candidate := filepath.Join(filepath.Dir(path), name)
			switch name {
			case "symlink":
				if err := os.Symlink(path, candidate); err != nil {
					t.Fatal(err)
				}
			case "parent-symlink":
				if err := os.Symlink(filepath.Dir(path), candidate); err != nil {
					t.Fatal(err)
				}
				candidate = filepath.Join(candidate, "image.png")
			case "directory":
				candidate = filepath.Dir(path)
			case "oversize":
				file, err := os.Create(candidate)
				if err != nil {
					t.Fatal(err)
				}
				if err := file.Truncate(protocol.MaxMediaBytes + 1); err != nil {
					t.Fatal(err)
				}
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
			case "svg":
				if err := os.WriteFile(candidate, []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			fixture := &mediaFixture{generation: "owner", refs: []protocol.NativeMediaReference{{ItemID: "item", TurnID: "turn", Path: candidate}}}
			d := NewDaemon(&config.Config{NodeID: "node"}, fixture)
			response := d.ListMedia(context.Background(), protocol.ListMediaMessage{Type: "list_media", RequestID: "list", NodeID: "node", SessionID: "session"})
			if len(response.Media) != 0 {
				t.Fatalf("unsafe file accepted: %s", name)
			}
			if response.Error != protocol.MediaUnavailable {
				t.Fatalf("unsafe image did not fail whole batch: %+v", response)
			}
		})
	}
}

func TestMediaListNeverPublishesPartialBatch(t *testing.T) {
	path := mediaFixturePath(t)
	mediaPNG(t, path, 32)
	fixture := &mediaFixture{generation: "owner", refs: []protocol.NativeMediaReference{
		{ItemID: "item", TurnID: "turn", Ordinal: 0, Path: path},
		{ItemID: "item", TurnID: "turn", Ordinal: 1, Path: filepath.Join(filepath.Dir(path), "missing.png")},
	}}
	d := NewDaemon(&config.Config{NodeID: "node"}, fixture)
	response := d.ListMedia(context.Background(), protocol.ListMediaMessage{Type: "list_media", RequestID: "list", NodeID: "node", SessionID: "session"})
	if response.Error != protocol.MediaUnavailable || len(response.Media) != 0 || response.MediaContext != "" || len(d.mediaState.bindings) != 0 {
		t.Fatalf("partial batch escaped: %+v", response)
	}
}

func TestMediaContextTTLConcurrencyAndCancellation(t *testing.T) {
	path := mediaFixturePath(t)
	mediaPNG(t, path, 32)
	d, _, list := mediaFixtureDaemon(t, path)
	request := mediaReadRequest(list)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := d.ReadMedia(ctx, request); got.Error != protocol.MediaTimeout {
		t.Fatal("cancelled operation continued")
	}
	for range maxConcurrentMediaReads {
		d.mediaState.slots <- struct{}{}
	}
	if got := d.ReadMedia(context.Background(), request); got.Error != protocol.MediaBusy {
		t.Fatal("concurrency bound ignored")
	}
	for range maxConcurrentMediaReads {
		<-d.mediaState.slots
	}
	d.mediaState.bindings[list.MediaContext].expiresAt = time.Now().Add(-time.Second)
	if got := d.ReadMedia(context.Background(), request); got.Error != protocol.MediaContextExpired {
		t.Fatal("expired context read succeeded")
	}
}
