package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
)

const maxLiveListBytes = 4 << 20

// liveSession is one entry of `claude agents --json`, the CLI's supported
// listing of live interactive and background sessions.
type liveSession struct {
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	Kind      string `json:"kind"`
	State     string `json:"state"`
	PID       int    `json:"pid"`
}

// liveSessions reports which session IDs and working directories another
// Claude Code process currently holds open. Any failure is returned so callers
// fail closed instead of treating an unknown state as idle.
type liveSessions struct {
	ids       map[string]bool
	anonymous map[string]bool // cwd of live entries without a session ID
}

func (l liveSessions) holds(id, cwd string) bool { return l.ids[id] || l.anonymous[cwd] }

func (l liveSession) live() bool {
	return l.PID > 0 || l.Kind == "background" && (l.State == "working" || l.State == "blocked")
}

func (a *Adapter) listLive(ctx context.Context) (liveSessions, error) {
	ctx, cancel := context.WithTimeout(ctx, a.cfg.LiveCheck)
	defer cancel()
	cmd := exec.CommandContext(ctx, a.cfg.ClaudePath, "agents", "--json")
	cmd.Env = a.env
	cmd.WaitDelay = a.cfg.InterruptGrace
	var stdout boundedBuffer
	stdout.limit = maxLiveListBytes
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return liveSessions{}, err
	}
	if stdout.overflow {
		return liveSessions{}, errors.New("claude agents output exceeds limit")
	}
	var entries []liveSession
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &entries); err != nil {
		return liveSessions{}, errors.New("claude agents output is not a JSON array")
	}
	result := liveSessions{ids: map[string]bool{}, anonymous: map[string]bool{}}
	for _, entry := range entries {
		if !entry.live() {
			continue
		}
		if entry.SessionID != "" {
			result.ids[entry.SessionID] = true
		} else if entry.Cwd != "" {
			result.anonymous[entry.Cwd] = true
		}
	}
	return result, nil
}

// boundedBuffer keeps at most limit bytes and records truncation.
type boundedBuffer struct {
	bytes.Buffer
	limit    int
	overflow bool
}

func (b *boundedBuffer) Write(data []byte) (int, error) {
	room := b.limit - b.Len()
	if room < len(data) {
		b.overflow = true
		if room > 0 {
			b.Buffer.Write(data[:room])
		}
		return len(data), nil
	}
	return b.Buffer.Write(data)
}
