package threadstate_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/client"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type markdownImageMediaFixture struct{ item map[string]any }

func (*markdownImageMediaFixture) DiscoverSessions(context.Context) ([]protocol.Session, error) {
	return nil, errors.New("unexpected discovery")
}
func (*markdownImageMediaFixture) ReadSession(context.Context, string) (string, error) {
	return "", errors.New("unexpected session read")
}
func (*markdownImageMediaFixture) SendPrompt(context.Context, string, string) (string, error) {
	return "", errors.New("unexpected prompt")
}
func (f *markdownImageMediaFixture) ListSessionMedia(ctx context.Context, _, _, _, _ string, _ int) ([]protocol.NativeMediaReference, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	return threadstate.ItemMedia(f.item), "markdown-images", nil
}
func (*markdownImageMediaFixture) ValidateMediaGeneration(ctx context.Context, _, _ string) error {
	return ctx.Err()
}

func TestItemMediaMarkdownDestinationsReadExactImageFiles(t *testing.T) {
	picture := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	picture.SetNRGBA(0, 0, color.NRGBA{R: 23, G: 47, B: 89, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	want := encoded.Bytes()
	tests := []struct {
		name, destination, filename string
		reference                   bool
	}{
		{name: "backslash", destination: `image\(1\).png`, filename: "image(1).png"},
		{name: "named-entity", destination: "a&amp;b.png", filename: "a&b.png"},
		{name: "numeric-hex-entity", destination: "a&#x2e;png", filename: "a.png"},
		{name: "numeric-decimal-entity", destination: "a&#46;png", filename: "a.png"},
		{name: "reference-image", destination: `image\(1\)&amp;b.png`, filename: "image(1)&b.png", reference: true},
		{name: "mixed-escapes", destination: `image\(1\)&amp;%2050%25.png`, filename: "image(1)& 50%.png"},
		{name: "single-percent-decode", destination: "image%2520.png", filename: "image%20.png"},
		{name: "percent-encoded-entity-stays-literal", destination: "image%26amp%3B.png", filename: "image&amp;.png"},
		{name: "percent-encoded-backslash-stays-literal", destination: "image%5C%281%5C%29.png", filename: `image\(1\).png`},
		{name: "nonpunctuation-backslash-stays-literal", destination: `image\q.png`, filename: `image\q.png`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			directory, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(directory, tc.filename)
			if err := os.WriteFile(path, want, 0600); err != nil {
				t.Fatal(err)
			}
			if tc.destination != tc.filename {
				decoy := append(append([]byte(nil), want...), 1)
				if err := os.WriteFile(filepath.Join(directory, tc.destination), decoy, 0600); err != nil {
					t.Fatal(err)
				}
			}
			directoryURL := &url.URL{Path: directory}
			destination := directoryURL.EscapedPath() + "/" + tc.destination
			source := fmt.Sprintf("![image](%s)", destination)
			if tc.reference {
				source = fmt.Sprintf("![image][local]\n\n[local]: %s", destination)
			}
			fixture := &markdownImageMediaFixture{item: map[string]any{
				"turnId": "turn", "item": map[string]any{"id": "item", "type": "agentMessage", "text": source},
			}}
			refs := threadstate.ItemMedia(fixture.item)
			if len(refs) != 1 || refs[0].Path != path {
				t.Fatalf("image destination resolved to %+v, want %q", refs, path)
			}
			daemon := client.NewDaemon(&config.Config{NodeID: "node"}, fixture)
			ctx := context.Background()
			listed := daemon.ListMedia(ctx, protocol.ListMediaMessage{Type: "list_media", RequestID: "list", NodeID: "node", SessionID: "session"})
			if listed.Error != "" || len(listed.Media) != 1 || listed.Media[0].MIME != "image/png" {
				t.Fatalf("cannot list decoded image file: %+v", listed)
			}
			chunk := daemon.ReadMedia(ctx, protocol.ReadMediaMessage{Type: "read_media", RequestID: "read", NodeID: "node", SessionID: "session",
				MediaContext: listed.MediaContext, MediaID: listed.Media[0].MediaID, MaxBytes: protocol.MaxMediaChunkBytes})
			if chunk.Error != "" || !chunk.EOF || !bytes.Equal(chunk.Data, want) {
				t.Fatalf("did not read exact decoded image file: error=%q eof=%t bytes=%d", chunk.Error, chunk.EOF, len(chunk.Data))
			}
		})
	}
}
