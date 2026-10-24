package threadstate

import (
	"net/url"
	"path/filepath"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	goldmarktext "github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

func markdownImagePaths(source string) []string {
	document := goldmark.New().Parser().Parse(goldmarktext.NewReader([]byte(source)))
	paths := []string{}
	err := ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		image, ok := node.(*ast.Image)
		if !entering || !ok {
			return ast.WalkContinue, nil
		}
		// Resolve Markdown escapes before decoding URL escapes exactly once.
		path := string(util.URLEscape(image.Destination, true))
		if decoded, err := url.PathUnescape(path); err == nil {
			path = decoded
		}
		paths = append(paths, path)
		// Images nested inside alternative text are not separately rendered.
		return ast.WalkSkipChildren, nil
	})
	if err != nil {
		return nil
	}
	return paths
}

func mediaString(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := raw[key].(string); ok && value != "" {
			return value
		}
	}
	return ""
}

// SelectItemMedia defaults to assistant replies while preserving explicit item/turn selection.
func SelectItemMedia(wrapper map[string]any, itemID, turnID string) []protocol.NativeMediaReference {
	item, ok := wrapper["item"].(map[string]any)
	if !ok {
		return nil
	}
	if itemID == "" && turnID == "" && item["type"] != "agentMessage" {
		return nil
	}
	if itemID != "" && mediaString(item, "id") != itemID || turnID != "" && mediaString(wrapper, "turnId") != turnID {
		return nil
	}
	return ItemMedia(wrapper)
}

// ItemMedia only accepts native image inputs or explicit assistant Markdown images.
func ItemMedia(wrapper map[string]any) []protocol.NativeMediaReference {
	item, ok := wrapper["item"].(map[string]any)
	if !ok {
		return nil
	}
	id, turn := mediaString(item, "id"), mediaString(wrapper, "turnId")
	if !protocol.ValidHistoryIdentity(id) || !protocol.ValidTurnID(turn) {
		return nil
	}
	paths := []string{}
	switch item["type"] {
	case "userMessage":
		content, _ := item["content"].([]any)
		for _, value := range content {
			block, ok := value.(map[string]any)
			if !ok {
				continue
			}
			switch block["type"] {
			case "localImage":
				paths = append(paths, mediaString(block, "path"))
			case "inputImage":
				paths = append(paths, mediaString(block, "path", "imageUrl", "image_url"))
			}
		}
	case "agentMessage":
		paths = markdownImagePaths(mediaString(item, "text"))
	}
	refs := []protocol.NativeMediaReference{}
	for ordinal, path := range paths {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsAny(path, "\x00\r\n") || strings.HasPrefix(path, "//") {
			continue
		}
		refs = append(refs, protocol.NativeMediaReference{ItemID: id, TurnID: turn, Ordinal: ordinal, Path: path})
	}
	return refs
}
