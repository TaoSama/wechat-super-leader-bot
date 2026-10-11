package codex

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

// Synthetic text only. Fixture construction is excluded from allocation counts;
// transport framing and its RawMessage copy are not included in these benchmarks.
func BenchmarkDesktopSnapshotProjection(b *testing.B) {
	const largeSnapshotTextBytes = 29 * 1024 * 1024
	state := controlState()
	state["latestModel"] = "benchmark-model"
	state["turns"] = []any{map[string]any{"turnId": "turn", "status": "completed", "items": []any{
		map[string]any{"id": "item", "type": "agentMessage", "text": strings.Repeat("x", largeSnapshotTextBytes)},
	}}}
	raw, err := json.Marshal(state)
	if err != nil {
		b.Fatal(err)
	}
	b.Run("observer-29MiB", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(raw)))
		for i := 0; i < b.N; i++ {
			var observation desktopRuntimeState
			if err := json.Unmarshal(raw, &observation); err != nil {
				b.Fatal(err)
			}
			if observation.ID != "session" {
				b.Fatal("wrong observation identity")
			}
		}
	})
	b.Run("control-29MiB", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(raw)))
		for i := 0; i < b.N; i++ {
			decoded, err := decodeDesktopControlState(raw)
			if err != nil || decoded.ID != "session" {
				b.Fatalf("control decode failed: %v", err)
			}
		}
	})
	b.Run("two-controls-29MiB", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(2 * int64(len(raw)))
		for i := 0; i < b.N; i++ {
			var workers sync.WaitGroup
			errors := make(chan error, 2)
			for range 2 {
				workers.Add(1)
				go func() {
					defer workers.Done()
					_, err := decodeDesktopControlState(raw)
					errors <- err
				}()
			}
			workers.Wait()
			close(errors)
			for err := range errors {
				if err != nil {
					b.Fatal(err)
				}
			}
		}
	})
}
