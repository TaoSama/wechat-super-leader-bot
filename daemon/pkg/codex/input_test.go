package codex

import (
	"context"
	"reflect"
	"testing"
)

func TestTurnInputAppendsLocalImagesAfterText(t *testing.T) {
	text := map[string]any{"type": "text", "text": "看图"}
	if got := TurnInput(context.Background(), text); !reflect.DeepEqual(got, []any{text}) {
		t.Fatalf("text-only input changed: %#v", got)
	}
	ctx := WithLocalImages(context.Background(), []string{"/private/a.png", "/private/b.jpg"})
	want := []any{text, map[string]any{"type": "localImage", "path": "/private/a.png"},
		map[string]any{"type": "localImage", "path": "/private/b.jpg"}}
	if got := TurnInput(ctx, text); !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected input: %#v", got)
	}
}
