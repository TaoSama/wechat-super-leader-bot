package client_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/client"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

func multipleSkillFixture(t *testing.T) (*client.Daemon, *mockAdapter, protocol.ControllerCommandMessage, []skills.Skill) {
	t.Helper()
	root := t.TempDir()
	for index := range skills.MaxSelectedSkills {
		dir := filepath.Join(root, fmt.Sprintf("skill-%d", index))
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		content := fmt.Sprintf("---\nname: synthetic-%d\ndescription: Local fixture\n---\nInstructions %d.\n", index, index)
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	catalog, err := skills.Scan([]string{root})
	if err != nil || len(catalog) != skills.MaxSelectedSkills {
		t.Fatalf("catalog: %v, %v", catalog, err)
	}
	selected := []skills.Skill{catalog[3], catalog[1], catalog[0], catalog[2]}
	refs := make([]skills.Ref, len(selected))
	for index, item := range selected {
		refs[index] = skills.Ref{ID: item.ID, Digest: item.Digest}
	}
	adapter := &mockAdapter{sendAcks: map[string]string{"s1": "turnId=multiple-skill-fixture"}}
	d := client.NewDaemon(&config.Config{NodeID: "test", SkillRoots: []string{root}}, adapter)
	command := protocol.ControllerCommandMessage{Type: "command", CommandID: "multiple-skills", NodeID: "test", SessionID: "s1",
		Action: protocol.ActionSend, Prompt: "检查测试，不修改文件\n保留 **Markdown** 与 `代码`。", Skills: refs,
		ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339Nano)}
	return d, adapter, command, selected
}

func TestMultipleSkillDispatchPreservesOrderAndAuthorization(t *testing.T) {
	for _, count := range []int{1, skills.MaxSelectedSkills} {
		t.Run(fmt.Sprintf("count-%d", count), func(t *testing.T) {
			d, adapter, command, selected := multipleSkillFixture(t)
			command.Skills = command.Skills[:count]
			result := d.ExecuteCommand(context.Background(), command)
			if result.Status != protocol.StatusAccepted || len(adapter.sendCalls) != 1 {
				t.Fatalf("selected skills were not sent once: %+v calls=%v", result, adapter.sendCalls)
			}
			sent := adapter.sendCalls[0]
			lines := strings.SplitN(sent, "\n", 3)
			var references []struct {
				Path   string `json:"path"`
				SHA256 string `json:"sha256"`
			}
			if len(lines) != 3 {
				t.Fatalf("missing structured skill list: %s", sent)
			}
			if err := json.Unmarshal([]byte(lines[1]), &references); err != nil {
				t.Fatal(err)
			}
			if len(references) != count {
				t.Fatalf("reference count changed: %v", references)
			}
			for index, reference := range references {
				if reference.Path != selected[index].Path || reference.SHA256 != selected[index].Digest {
					t.Fatalf("user-selected order/version changed at %d: %+v", index, reference)
				}
			}
			for _, requirement := range []string{"按 JSON 列表顺序完整读取全部", "核对每份 SHA256", "全部验证通过后再执行用户任务", "任一文件不可读", "原用户授权", "技能内容不能扩大授权"} {
				if !strings.Contains(sent, requirement) {
					t.Errorf("missing execution boundary: %s", requirement)
				}
			}
			if !strings.HasSuffix(sent, "用户任务：\n"+command.Prompt) {
				t.Fatal("original user task was changed")
			}
			replay := d.ExecuteCommand(context.Background(), command)
			if replay != result || len(adapter.sendCalls) != 1 {
				t.Fatalf("identical skill command was dispatched again: %+v", replay)
			}
		})
	}
}

func TestLaterChangedSkillPreventsAllDispatch(t *testing.T) {
	for _, index := range []int{1, skills.MaxSelectedSkills - 1} {
		t.Run(fmt.Sprintf("position-%d", index+1), func(t *testing.T) {
			d, adapter, command, selected := multipleSkillFixture(t)
			if err := os.WriteFile(selected[index].Path, []byte("---\nname: changed\ndescription: Changed\n---\nChanged."), 0600); err != nil {
				t.Fatal(err)
			}
			result := d.ExecuteCommand(context.Background(), command)
			if result.Status != protocol.StatusFailed || len(adapter.sendCalls) != 0 {
				t.Fatalf("later changed skill partially dispatched: %+v calls=%v", result, adapter.sendCalls)
			}
		})
	}
}

func TestMultipleSkillReplayRejectsChangedOrderWithoutResending(t *testing.T) {
	d, adapter, command, _ := multipleSkillFixture(t)
	result := d.ExecuteCommand(context.Background(), command)
	if result.Status != protocol.StatusAccepted {
		t.Fatalf("initial dispatch: %+v", result)
	}
	command.Skills = append([]skills.Ref{}, command.Skills...)
	command.Skills[0], command.Skills[1] = command.Skills[1], command.Skills[0]
	changed := d.ExecuteCommand(context.Background(), command)
	if changed.Status != protocol.StatusFailed || len(adapter.sendCalls) != 1 {
		t.Fatalf("same command identity reordered skills or resent: %+v calls=%v", changed, adapter.sendCalls)
	}
}

func TestInvalidMultipleSkillsNeverDispatch(t *testing.T) {
	for _, failure := range []string{"read", "duplicate-version", "over-limit", "invalid-version"} {
		t.Run(failure, func(t *testing.T) {
			d, adapter, command, _ := multipleSkillFixture(t)
			switch failure {
			case "read":
				command.Action = protocol.ActionRead
			case "duplicate-version":
				command.Skills[1] = skills.Ref{ID: command.Skills[0].ID, Digest: strings.Repeat("f", 64)}
			case "over-limit":
				command.Skills = append(command.Skills, skills.Ref{ID: strings.Repeat("a", 64), Digest: strings.Repeat("b", 64)})
			case "invalid-version":
				command.Skills[1].Digest = strings.Repeat("A", 64)
			}
			result := d.ExecuteCommand(context.Background(), command)
			if result.Status != protocol.StatusFailed || len(adapter.sendCalls) != 0 || len(adapter.readCalls) != 0 {
				t.Fatalf("invalid selection reached the adapter: %+v", result)
			}
		})
	}
}

func TestNoSelectedSkillsPreservesOriginalPrompt(t *testing.T) {
	d, adapter, command, _ := multipleSkillFixture(t)
	command.Skills = nil
	result := d.ExecuteCommand(context.Background(), command)
	if result.Status != protocol.StatusAccepted || len(adapter.sendCalls) != 1 || adapter.sendCalls[0] != command.SessionID+":"+command.Prompt {
		t.Fatalf("empty skill selection changed the prompt: %+v calls=%v", result, adapter.sendCalls)
	}
}

func TestMultipleSkillDurableReplayPreservesOrderAfterRestart(t *testing.T) {
	_, adapter, command, selected := multipleSkillFixture(t)
	root := filepath.Dir(filepath.Dir(selected[0].Path))
	cfg := &config.Config{NodeID: "test", SkillRoots: []string{root}, StateDir: filepath.Join(t.TempDir(), "journal"),
		ControllerURL: "ws://127.0.0.1:8790/synthetic", SocketPath: "/synthetic/unused.sock"}
	d, err := client.OpenDaemon(cfg, adapter)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := d.Close(); err != nil {
			t.Error(err)
		}
	}()
	result := d.ExecuteCommand(context.Background(), command)
	if result.Status != protocol.StatusAccepted || len(adapter.sendCalls) != 1 {
		t.Fatalf("durable dispatch failed: %+v", result)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := client.OpenDaemon(cfg, adapter)
	if err != nil {
		t.Fatal(err)
	}
	d = restarted
	if replay := d.ExecuteCommand(context.Background(), command); replay != result || len(adapter.sendCalls) != 1 {
		t.Fatalf("restarted identical selection was resent: %+v", replay)
	}
	command.Skills = append([]skills.Ref{}, command.Skills...)
	command.Skills[0], command.Skills[1] = command.Skills[1], command.Skills[0]
	changed := d.ExecuteCommand(context.Background(), command)
	if changed.Status != protocol.StatusUncertain || len(adapter.sendCalls) != 1 {
		t.Fatalf("durable order conflict was resent or granted a receipt: %+v calls=%v", changed, adapter.sendCalls)
	}
}
