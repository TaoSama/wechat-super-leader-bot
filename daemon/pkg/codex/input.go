package codex

import "context"

type inputImagesKey struct{}

// WithLocalImages attaches local image paths to one send. Adapters that build
// app-server input add them as localImage items after the text item; routes
// that cannot carry images never read this value.
func WithLocalImages(ctx context.Context, paths []string) context.Context {
	if len(paths) == 0 {
		return ctx
	}
	return context.WithValue(ctx, inputImagesKey{}, append([]string(nil), paths...))
}

// LocalImages returns the image paths attached by WithLocalImages.
func LocalImages(ctx context.Context) []string {
	paths, _ := ctx.Value(inputImagesKey{}).([]string)
	return paths
}

// TurnInput builds app-server UserInput items: the text first, then each
// attached image as {type:"localImage", path}.
func TurnInput(ctx context.Context, text map[string]any) []any {
	items := []any{text}
	for _, path := range LocalImages(ctx) {
		items = append(items, map[string]any{"type": "localImage", "path": path})
	}
	return items
}
