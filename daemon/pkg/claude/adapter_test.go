package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	testSessionID = "11111111-2222-4333-8444-555555555555"
	testTurnID    = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	waitLimit     = 10 * time.Second
)

// fakeClaude is a shell script standing in for the CLI. It records its
// arguments, working directory, environment and stdin, then follows MODE.
const fakeClaude = `#!/bin/sh
dir="$(dirname "$0")"
if [ "$1" = "agents" ]; then
  if [ -f "$dir/agents.fail" ]; then exit 3; fi
  if [ -f "$dir/agents.json" ]; then cat "$dir/agents.json"; else echo '[]'; fi
  exit 0
fi
printf '%s\n' "$@" > "$dir/args"
pwd > "$dir/cwd"
env > "$dir/env"
cat > "$dir/stdin"
sid="$3"
mode="$(cat "$dir/mode")"
init='{"type":"system","subtype":"init","session_id":"'"$sid"'"}'
case "$mode" in
  success)
    echo "$init"
    echo '{"type":"assistant","session_id":"'"$sid"'","message":{"content":[{"type":"text","text":"working"}]}}'
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"'"$sid"'","result":"final answer","permission_denials":[]}'
    ;;
  error)
    echo "$init"
    echo '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"'"$sid"'","result":"too many turns"}'
    exit 1
    ;;
  crash)
    echo "$init"
    kill -9 $$
    ;;
  refuse)
    echo "session is running in the background" >&2
    exit 1
    ;;
  other)
    echo '{"type":"system","subtype":"init","session_id":"99999999-2222-4333-8444-555555555555"}'
    sleep 30
    ;;
  hang)
    echo "$init"
    trap 'exit 130' INT
    sleep 30 &
    wait
    ;;
esac
`

type fixture struct {
	t       *testing.T
	root    string
	bin     string
	cwd     string
	adapter *Adapter
}

func newFixture(t *testing.T, mode string) *fixture {
	t.Helper()
	base := t.TempDir()
	cwd := filepath.Join(base, "work", "repo")
	bin := filepath.Join(base, "bin")
	root := filepath.Join(base, "config", projectsDirName)
	for _, dir := range []string{cwd, bin, filepath.Join(root, encodeProjectName(cwd))} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	f := &fixture{t: t, root: root, bin: bin, cwd: cwd}
	f.write(filepath.Join(bin, "claude"), fakeClaude, 0o700)
	f.write(filepath.Join(bin, "mode"), mode, 0o600)
	f.writeTranscript(time.Now().Add(-time.Hour))
	t.Setenv("NODE_TOKEN", "secret-node-token")
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("CLAUDE_CONFIG_DIR", "/should/not/leak")
	adapter, err := New(Config{ProjectsRoot: root, ClaudePath: filepath.Join(bin, "claude"), InterruptGrace: 200 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	f.adapter = adapter
	t.Cleanup(adapter.Close)
	return f
}

func (f *fixture) write(path, content string, mode os.FileMode) {
	f.t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) transcriptPath() string {
	return filepath.Join(f.root, encodeProjectName(f.cwd), testSessionID+transcriptSuffix)
}

func (f *fixture) writeTranscript(modified time.Time) {
	f.t.Helper()
	lines := []string{
		`{"type":"user","sessionId":"` + testSessionID + `","cwd":"` + f.cwd + `","isSidechain":false,"message":{"role":"user","content":"Fix the flaky test"},"timestamp":"2026-11-01T00:00:00Z"}`,
		`{"type":"assistant","sessionId":"` + testSessionID + `","cwd":"` + f.cwd + `","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"Done."}]},"timestamp":"2026-11-01T00:00:01Z"}`,
	}
	f.write(f.transcriptPath(), strings.Join(lines, "\n")+"\n", 0o600)
	if err := os.Chtimes(f.transcriptPath(), modified, modified); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) read(name string) string {
	f.t.Helper()
	data, err := os.ReadFile(filepath.Join(f.bin, name))
	if err != nil {
		f.t.Fatal(err)
	}
	return string(data)
}

func (f *fixture) finish(turnID string) turnView {
	f.t.Helper()
	done, ok := f.adapter.Done(turnID)
	if !ok {
		f.t.Fatal("turn not registered")
	}
	select {
	case <-done:
	case <-time.After(waitLimit):
		f.t.Fatal("turn did not finish")
	}
	observation, err := f.adapter.InspectTurn(context.Background(), PublicID(testSessionID), turnID)
	return turnView{observation.Status, observation.Output, observation.Error, err}
}

type turnView struct {
	Status, Output, Error string
	Err                   error
}

func TestDiscoverSessionsReportsIdleTranscript(t *testing.T) {
	f := newFixture(t, "success")
	sessions, err := f.adapter.DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 1 {
		t.Fatalf("discover: %v %+v", err, sessions)
	}
	session := sessions[0]
	if session.ID != PublicID(testSessionID) || session.Provider != ProviderClaudeCode || session.Cwd != f.cwd ||
		session.Title != "Fix the flaky test" || session.Status != StatusIdle || session.Loaded == nil || *session.Loaded ||
		len(session.Capabilities) != 2 || session.Capabilities[1] != protocol.CapabilityResumeSend {
		t.Fatalf("unexpected session: %+v", session)
	}
}

func TestDiscoverSessionsMarksBusySources(t *testing.T) {
	f := newFixture(t, "success")
	f.writeTranscript(time.Now())
	if status := discoveredStatus(t, f); status != StatusActive {
		t.Fatalf("recently written transcript reported %q", status)
	}
	f.writeTranscript(time.Now().Add(-time.Hour))
	f.write(filepath.Join(f.bin, "agents.json"), `[{"kind":"interactive","cwd":"/x","pid":42,"sessionId":"`+testSessionID+`"}]`, 0o600)
	if status := discoveredStatus(t, f); status != StatusActive {
		t.Fatalf("session open in a live terminal reported %q", status)
	}
	f.write(filepath.Join(f.bin, "agents.json"), `[{"kind":"interactive","cwd":"`+f.cwd+`","pid":42}]`, 0o600)
	if status := discoveredStatus(t, f); status != StatusActive {
		t.Fatalf("anonymous live session in the same cwd reported %q", status)
	}
	f.write(filepath.Join(f.bin, "agents.fail"), "", 0o600)
	if status := discoveredStatus(t, f); status != StatusUnknown {
		t.Fatalf("failed live check reported %q", status)
	}
}

func discoveredStatus(t *testing.T, f *fixture) string {
	t.Helper()
	sessions, err := f.adapter.DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 1 {
		t.Fatalf("discover: %v %+v", err, sessions)
	}
	return sessions[0].Status
}

func TestDiscoverSessionsRejectsMismatchedProjectDirectory(t *testing.T) {
	f := newFixture(t, "success")
	other := filepath.Join(f.root, "-elsewhere")
	if err := os.MkdirAll(other, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(f.transcriptPath(), filepath.Join(other, testSessionID+transcriptSuffix)); err != nil {
		t.Fatal(err)
	}
	sessions, err := f.adapter.DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 0 {
		t.Fatalf("spoofed cwd accepted: %v %+v", err, sessions)
	}
}
