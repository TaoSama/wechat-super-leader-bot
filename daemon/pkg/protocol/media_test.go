package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMediaReadOnlyAcceptsOpaqueBoundReferences(t *testing.T) {
	id, err := NewDispatchID()
	if err != nil {
		t.Fatal(err)
	}
	valid := ReadMediaMessage{Type: "read_media", RequestID: "request", NodeID: "node", SessionID: "session", MediaContext: id, MediaID: id, MaxBytes: MaxMediaChunkBytes}
	if err := valid.Validate("node"); err != nil {
		t.Fatal(err)
	}
	for _, reference := range []string{"/tmp/image.png", "https://example.com/image.png", "../private", "", strings.Repeat("f", 36)} {
		bad := valid
		bad.MediaID = reference
		if err := bad.Validate("node"); err == nil {
			t.Fatalf("accepted %q", reference)
		}
	}
	encoded, err := json.Marshal(NativeMediaReference{ItemID: "item", Path: "/private/image.png"})
	if err != nil || string(encoded) != "{}" {
		t.Fatalf("native media path leaked %s %v", encoded, err)
	}
}
