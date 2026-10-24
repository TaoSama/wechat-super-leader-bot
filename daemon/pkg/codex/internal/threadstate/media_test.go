package threadstate

import "testing"

func TestItemMediaRequiresExplicitLocalImageAttachments(t *testing.T) {
	tests := []struct {
		name string
		item map[string]any
		want []string
	}{
		{"markdown", map[string]any{"type": "agentMessage", "text": "裸路径 /private/secret.png\n![one](/tmp/one.png) ![two](</tmp/two image.jpg>) ![remote](https://example.com/x.png) [file](/tmp/not-image.png)"}, []string{"/tmp/one.png", "/tmp/two image.jpg"}},
		{"native", map[string]any{"type": "userMessage", "content": []any{map[string]any{"type": "localImage", "path": "/tmp/input.png"}, map[string]any{"type": "inputImage", "imageUrl": "https://example.com/x.png"}, map[string]any{"type": "inputImage", "image_url": "/tmp/input.jpg"}}}, []string{"/tmp/input.png", "/tmp/input.jpg"}},
		{"tool-output", map[string]any{"type": "commandExecution", "aggregatedOutput": "![secret](/tmp/secret.png)"}, nil},
		{"text-input", map[string]any{"type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "![secret](/tmp/secret.png)"}}}, nil},
		{"relative-and-url", map[string]any{"type": "agentMessage", "text": "![a](relative.png) ![b](file:///tmp/image.png) ![c](//server/share.png) ![d](data:image/png;base64,AAAA)"}, nil},
		{"fenced-code", map[string]any{"type": "agentMessage", "text": "```markdown\n![secret](/private/secret.png)\n```\n![real](/tmp/real.png)"}, []string{"/tmp/real.png"}},
		{"tilde-fenced-code", map[string]any{"type": "agentMessage", "text": "~~~markdown\n![secret](/private/secret.png)\n~~~"}, nil},
		{"inline-code", map[string]any{"type": "agentMessage", "text": "`![secret](/private/secret.png)` and ``![secret](/private/other.png)``"}, nil},
		{"escaped-image", map[string]any{"type": "agentMessage", "text": "\\![secret](/private/secret.png)"}, nil},
		{"html-comment", map[string]any{"type": "agentMessage", "text": "<!--\n![secret](/private/secret.png)\n-->\n![real](/tmp/real.png)"}, []string{"/tmp/real.png"}},
		{"indented-code", map[string]any{"type": "agentMessage", "text": "    ![secret](/private/secret.png)"}, nil},
		{"nested-alt-image", map[string]any{"type": "agentMessage", "text": "![![secret](/private/secret.png)](/tmp/real.png)"}, []string{"/tmp/real.png"}},
		{"inline-html-comment", map[string]any{"type": "agentMessage", "text": "example <!-- ![secret](/private/secret.png) --> ![real](/tmp/real.png)"}, []string{"/tmp/real.png"}},
		{"percent-escaped-path", map[string]any{"type": "agentMessage", "text": "![real](/tmp/my%20image.png) ![remote](https%3A%2F%2Fexample.com%2Fsecret.png)"}, []string{"/tmp/my image.png"}},
		{"noncanonical-path", map[string]any{"type": "agentMessage", "text": "![secret](/tmp/link/../private.png)"}, nil},
		{"entity-noncanonical-path", map[string]any{"type": "agentMessage", "text": "![secret](/tmp/&#46;&#46;/private.png)"}, nil},
		{"entity-network-path", map[string]any{"type": "agentMessage", "text": "![secret](&#47;&#47;server/share.png)"}, nil},
		{"entity-line-ending", map[string]any{"type": "agentMessage", "text": "![secret](/tmp/a&NewLine;b.png)"}, nil},
		{"entity-url", map[string]any{"type": "agentMessage", "text": "![secret](https&colon;//example.com/secret.png)"}, nil},
		{"entity-percent-nul", map[string]any{"type": "agentMessage", "text": "![secret](/tmp/a&#37;00.png)"}, nil},
		{"native-path-is-not-trimmed", map[string]any{"type": "userMessage", "content": []any{map[string]any{"type": "localImage", "path": " /private/secret.png"}}}, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tc.item["id"] = "item"
			refs := ItemMedia(map[string]any{"turnId": "turn", "item": tc.item})
			if len(refs) != len(tc.want) {
				t.Fatalf("got %+v", refs)
			}
			for i, ref := range refs {
				if ref.Path != tc.want[i] || ref.ItemID != "item" || ref.TurnID != "turn" {
					t.Fatalf("wrong attachment %+v", ref)
				}
			}
		})
	}
}
