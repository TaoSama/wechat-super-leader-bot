package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	attachmentTestToken = "node-token"
	attachmentImageID   = "6f1c2a8e-1d2b-4c3d-8e9f-0a1b2c3d4e5f"
	attachmentFileID    = "7a2d3b9f-2e3c-4d4e-9f0a-1b2c3d4e5f60"
)

func attachmentRef(id, kind, name, mime string, data []byte) protocol.CommandAttachment {
	digest := sha256.Sum256(data)
	return protocol.CommandAttachment{ID: id, Kind: kind, Name: name, Mime: mime, Size: int64(len(data)), SHA256: hex.EncodeToString(digest[:])}
}

func attachmentDaemon(t *testing.T, bodies map[string][]byte) (*Daemon, *[]string) {
	t.Helper()
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer "+attachmentTestToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body, ok := bodies[filepath.Base(r.URL.Path)]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if _, err := w.Write(body); err != nil {
			t.Errorf("write attachment: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	cfg := &config.Config{ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/daemon", NodeToken: attachmentTestToken, StateDir: t.TempDir()}
	return &Daemon{cfg: cfg, attachmentClient: server.Client()}, &paths
}

func TestMaterializeAttachmentsWritesPrivateFilesAndBuildsInput(t *testing.T) {
	image := []byte("\x89PNG\r\n\x1a\nfixture")
	file := []byte("quarterly numbers")
	d, paths := attachmentDaemon(t, map[string][]byte{attachmentImageID: image, attachmentFileID: file})
	cmd := protocol.ControllerCommandMessage{CommandID: "cmd_1", Attachments: []protocol.CommandAttachment{
		attachmentRef(attachmentImageID, protocol.AttachmentKindImage, "image.png", "image/png", image),
		attachmentRef(attachmentFileID, protocol.AttachmentKindFile, "report.txt", "text/plain", file)}}
	result, err := d.materializeAttachments(context.Background(), cmd, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := "/v1/daemon/attachments/cmd_1/" + attachmentImageID; (*paths)[0] != want {
		t.Fatalf("fetch path = %q, want %q", (*paths)[0], want)
	}
	if info, err := os.Stat(result.dir); err != nil || info.Mode().Perm() != attachmentDirMode {
		t.Fatalf("command directory mode: %v %v", info, err)
	}
	if len(result.images) != 1 || filepath.Dir(result.images[0]) != result.dir {
		t.Fatalf("images = %#v", result.images)
	}
	for _, path := range []string{result.images[0], filepath.Join(result.dir, "attachment-2.txt")} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != attachmentFileMode {
			t.Fatalf("attachment file %s mode: %v %v", path, info, err)
		}
	}
	ctx, prompt := result.apply(context.Background(), "看看")
	if got := codex.LocalImages(ctx); len(got) != 1 || got[0] != result.images[0] {
		t.Fatalf("local images = %#v", got)
	}
	if !strings.Contains(prompt, filepath.Join(result.dir, "attachment-2.txt")) || strings.Contains(prompt, "attachment-1.png") {
		t.Fatalf("prompt must reference only the file by path: %q", prompt)
	}
	result.release(false)
	if _, err := os.Stat(result.dir); !os.IsNotExist(err) {
		t.Fatalf("unsent attachments must be removed: %v", err)
	}
}

func TestMaterializeAttachmentsTextOnlyRouteReferencesImagesByPath(t *testing.T) {
	image := []byte("\xff\xd8\xff fixture")
	d, _ := attachmentDaemon(t, map[string][]byte{attachmentImageID: image})
	cmd := protocol.ControllerCommandMessage{CommandID: "cmd_2", Attachments: []protocol.CommandAttachment{
		attachmentRef(attachmentImageID, protocol.AttachmentKindImage, "image.jpg", "image/jpeg", image)}}
	result, err := d.materializeAttachments(context.Background(), cmd, true)
	if err != nil {
		t.Fatal(err)
	}
	defer result.remove()
	ctx, prompt := result.apply(context.Background(), "看看")
	if len(codex.LocalImages(ctx)) != 0 || !strings.Contains(prompt, "attachment-1.jpg") {
		t.Fatalf("text-only route: images=%v prompt=%q", codex.LocalImages(ctx), prompt)
	}
}

func TestMaterializeAttachmentsRejectsTamperedBytesAndCleansUp(t *testing.T) {
	d, _ := attachmentDaemon(t, map[string][]byte{attachmentImageID: []byte("tampered")})
	cmd := protocol.ControllerCommandMessage{CommandID: "cmd_3", Attachments: []protocol.CommandAttachment{
		attachmentRef(attachmentImageID, protocol.AttachmentKindImage, "image.png", "image/png", []byte("original"))}}
	if _, err := d.materializeAttachments(context.Background(), cmd, false); err == nil {
		t.Fatal("hash mismatch accepted")
	}
	entries, err := os.ReadDir(filepath.Join(d.cfg.StateDir, attachmentRootName))
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed fetch left files behind: %v %v", entries, err)
	}
}

func TestLocalAttachmentNameDropsLongOrUnsafeNames(t *testing.T) {
	long := strings.Repeat("季度报告", 80) + ".pdf"
	for name, want := range map[string]string{long: "attachment-1.pdf", "notes.tar.gz": "attachment-1.gz", "a.<x>": "attachment-1", "noext": "attachment-1"} {
		if got := localAttachmentName(0, name); got != want {
			t.Errorf("localAttachmentName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestSweepAttachmentsRemovesOnlyExpiredCommandDirectories(t *testing.T) {
	root := t.TempDir()
	old, fresh, other := filepath.Join(root, attachmentDirPrefix+"old"), filepath.Join(root, attachmentDirPrefix+"fresh"), filepath.Join(root, "keep")
	for _, dir := range []string{old, fresh, other} {
		if err := os.Mkdir(dir, attachmentDirMode); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-AttachmentRetention - time.Minute)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(other, past, past); err != nil {
		t.Fatal(err)
	}
	sweepAttachments(root, time.Now())
	for dir, exists := range map[string]bool{old: false, fresh: true, other: true} {
		if _, err := os.Stat(dir); (err == nil) != exists {
			t.Errorf("%s exists=%t, want %t", dir, err == nil, exists)
		}
	}
}

func TestAttachmentURLFollowsControllerScheme(t *testing.T) {
	got, err := attachmentURL("wss://leader.example.com/v1/daemon", "cmd_x", attachmentImageID)
	if err != nil || got != "https://leader.example.com/v1/daemon/attachments/cmd_x/"+attachmentImageID {
		t.Fatalf("url=%q err=%v", got, err)
	}
	if _, err := attachmentURL("http://leader.example.com/v1/daemon", "cmd_x", attachmentImageID); err == nil {
		t.Fatal("non-WebSocket controller URL accepted")
	}
}
