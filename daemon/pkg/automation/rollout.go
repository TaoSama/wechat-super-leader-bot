package automation

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

const (
	rolloutTailLimit = 32 << 20
	rolloutLineLimit = 2 << 20
	rolloutTextLimit = 256 << 10
	rolloutTurnLimit = 8192
)

// Evidence describes one exactly identified scheduled turn, never the latest chat reply.
type Evidence struct {
	Status  string
	TurnID  string
	Text    string
	Reason  string
	Sources []string
}

type rolloutRecord struct {
	Timestamp string         `json:"timestamp"`
	Type      string         `json:"type"`
	Payload   rolloutPayload `json:"payload"`
}

type rolloutPayload struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	TurnID  string `json:"turn_id"`
	Role    string `json:"role"`
	Phase   string `json:"phase"`
	Content []struct {
		Text string `json:"text"`
	} `json:"content"`
	Metadata struct {
		TurnID string `json:"turn_id"`
	} `json:"internal_chat_message_metadata_passthrough"`
	Attribution struct {
		Trigger string `json:"turn_trigger"`
	} `json:"turn_attribution"`
	Item struct {
		Type    string          `json:"type"`
		Phase   string          `json:"phase"`
		Content json.RawMessage `json:"content"`
	} `json:"item"`
}

type rolloutTurn struct {
	complete    bool
	aborted     bool
	final       string
	trigger     string
	firstRecord int
	lastRecord  int
	invalid     bool
}

type heartbeatEnvelope struct {
	AutomationID string `xml:"automation_id"`
	CurrentTime  string `xml:"current_time_iso"`
}

func inspectRollout(ctx context.Context, home, path, sessionID, automationID string, expectedAt, notAfter int64, heartbeat bool) (evidence Evidence, retErr error) {
	if err := ctx.Err(); err != nil {
		return Evidence{}, err
	}
	unknown := func(reason string) Evidence {
		return Evidence{Status: "unknown", Reason: reason, Sources: []string{"rollout:" + sessionID}}
	}
	if expectedAt <= 0 || notAfter < expectedAt {
		return unknown("invalid run time window"), nil
	}
	f, err := openRollout(home, path)
	if err != nil {
		return Evidence{}, err
	}
	defer func() { retErr = errors.Join(retErr, f.Close()) }()
	info, err := f.Stat()
	if err != nil {
		return Evidence{}, fmt.Errorf("stat rollout: %w", err)
	}
	if !info.Mode().IsRegular() {
		return unknown("rollout is not a regular file"), nil
	}
	truncated := info.Size() > rolloutTailLimit
	if truncated {
		if _, err := f.Seek(info.Size()-rolloutTailLimit, io.SeekStart); err != nil {
			return Evidence{}, fmt.Errorf("seek rollout: %w", err)
		}
	}
	scanner := bufio.NewScanner(io.LimitReader(f, rolloutTailLimit))
	scanner.Buffer(make([]byte, 64<<10), rolloutLineLimit)
	if truncated && !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return unknown("rollout tail starts with an oversized record"), nil
		}
		return unknown("rollout tail contains no complete records"), nil
	}
	turns := map[string]*rolloutTurn{}
	candidates := map[string]bool{}
	supported, missingIdentity := false, false
	invalidRecords := []int{}
	recordIndex := 0
	for scanner.Scan() {
		recordIndex++
		if err := ctx.Err(); err != nil {
			return Evidence{}, err
		}
		var rec rolloutRecord
		if err := json.Unmarshal(scanner.Bytes(), &rec); err != nil {
			invalidRecords = append(invalidRecords, recordIndex)
			continue
		}
		p := rec.Payload
		if rec.Type != "event_msg" && rec.Type != "response_item" && rec.Type != "turn_context" && rec.Type != "session_meta" {
			continue
		}
		if rec.Type == "session_meta" {
			if p.ID != "" && sessionID != "" && p.ID != sessionID {
				return unknown("rollout session ID disagrees with mapped thread"), nil
			}
			continue
		}
		if (rec.Type == "event_msg" && (p.Type == "task_started" || p.Type == "task_complete" || p.Type == "turn_aborted" || p.Type == "item_completed")) || (rec.Type == "response_item" && p.Type == "message") {
			supported = true
		}
		id := p.TurnID
		if id == "" {
			id = p.Metadata.TurnID
		}
		if id != "" && turns[id] == nil {
			if len(turns) >= rolloutTurnLimit {
				return Evidence{}, ErrTooLarge
			}
			turns[id] = &rolloutTurn{firstRecord: recordIndex, lastRecord: recordIndex}
		}
		if id != "" {
			turns[id].lastRecord = recordIndex
		}
		if heartbeat && rec.Type == "response_item" && p.Type == "message" && p.Role == "user" {
			for _, content := range p.Content {
				text := strings.TrimSpace(content.Text)
				if !strings.HasPrefix(text, "<heartbeat>") {
					continue
				}
				envelope, err := parseHeartbeatEnvelope(text)
				if err != nil {
					markTurnInvalid(turns, id)
					continue
				}
				if envelope.AutomationID != automationID {
					continue
				}
				at, err := time.Parse(time.RFC3339Nano, envelope.CurrentTime)
				if err != nil {
					markTurnInvalid(turns, id)
					continue
				}
				if !inRolloutWindow(at.UnixMilli(), expectedAt, notAfter) {
					continue
				}
				if p.Metadata.TurnID == "" {
					missingIdentity = true
					continue
				}
				candidates[p.Metadata.TurnID] = true
			}
		}
		if !heartbeat && rec.Type == "event_msg" && p.Type == "task_started" && cronTrigger(p.Attribution.Trigger) {
			at, err := time.Parse(time.RFC3339Nano, rec.Timestamp)
			if err != nil {
				markTurnInvalid(turns, id)
				continue
			}
			if inRolloutWindow(at.UnixMilli(), expectedAt, notAfter) {
				if id == "" {
					missingIdentity = true
				} else {
					candidates[id] = true
				}
			}
		}
		if id == "" {
			continue
		}
		turn := turns[id]
		if rec.Type == "event_msg" {
			switch p.Type {
			case "task_started":
				if p.Attribution.Trigger != "" {
					if turn.trigger != "" && turn.trigger != p.Attribution.Trigger {
						turn.trigger = "conflicting_turn_triggers"
					} else {
						turn.trigger = p.Attribution.Trigger
					}
				}
			case "task_complete":
				turn.complete = true
			case "turn_aborted", "task_failed", "turn_failed":
				turn.aborted = true
			case "item_completed":
				if p.Item.Type == "AgentMessage" && isFinalPhase(p.Item.Phase) {
					text, err := rolloutItemText(p.Item.Content)
					if err != nil {
						turn.invalid = true
					} else {
						turn.final = text
					}
				}
			}
		}
		if rec.Type == "response_item" && p.Type == "message" && p.Role == "assistant" && isFinalPhase(p.Phase) {
			var parts []string
			for _, content := range p.Content {
				parts = append(parts, content.Text)
			}
			turn.final = strings.Join(parts, "\n")
		}
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return Evidence{}, ErrTooLarge
		}
		return Evidence{}, fmt.Errorf("read rollout: %w", err)
	}
	if missingIdentity {
		return unknown("matching scheduled message has no exact turn ID"), nil
	}
	if len(candidates) > 1 {
		return unknown("multiple scheduled turns match this run window"), nil
	}
	if len(candidates) == 0 {
		if truncated {
			return unknown("run evidence absent from bounded rollout tail"), nil
		}
		if !supported || !heartbeat {
			return unknown("no supported exact scheduled-turn evidence"), nil
		}
		return Evidence{Status: "waiting", Reason: "scheduled heartbeat has not appeared in this run window", Sources: []string{"rollout:" + sessionID}}, nil
	}
	for id := range candidates {
		turn := turns[id]
		result := Evidence{Status: "running", TurnID: id, Sources: []string{"rollout:" + sessionID + "#turn=" + id}}
		if turn == nil {
			return unknown("matching turn state is unavailable"), nil
		}
		if turn.invalid || invalidRecordWithin(turn, invalidRecords) {
			return unknown("rollout contains malformed records for the scheduled turn"), nil
		}
		if heartbeat && turn.trigger != "automation_heartbeat_scheduled" {
			result.Status = "unknown"
			result.Reason = "heartbeat XML has no trusted native scheduled trigger"
			return result, nil
		}
		if turn.aborted {
			result.Status = "failed"
			result.Reason = "scheduled turn was aborted or failed"
			return result, nil
		}
		if len(turn.final) > rolloutTextLimit {
			return Evidence{}, ErrTooLarge
		}
		if turn.complete {
			if strings.TrimSpace(turn.final) == "" {
				result.Status = "unknown"
				result.Reason = "completed turn has no exact final answer"
			} else {
				result.Status = "completed"
				result.Text = turn.final
			}
		}
		return result, nil
	}
	return unknown("scheduled turn was not identified"), nil
}

func isFinalPhase(phase string) bool { return phase == "final" || phase == "final_answer" }

func inRolloutWindow(at, expected, until int64) bool { return at >= expected && at <= until }

func cronTrigger(trigger string) bool {
	return trigger == "automation_cron_scheduled" || trigger == "automation_scheduled"
}

// parseHeartbeatEnvelope reads the identity fields from the native heartbeat
// wrapper. The instructions element is model-authored text and may contain
// literal '<' or '&' characters, so parsing the complete message as XML would
// reject valid heartbeats. The wrapper and its identity fields remain strict;
// the opaque instructions tail is deliberately not interpreted.
func parseHeartbeatEnvelope(text string) (heartbeatEnvelope, error) {
	var envelope heartbeatEnvelope
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "<heartbeat>") {
		return envelope, errors.New("heartbeat root missing")
	}
	text = strings.TrimPrefix(text, "<heartbeat>")
	var err error
	if envelope.AutomationID, text, err = readHeartbeatField(text, "automation_id"); err != nil {
		return heartbeatEnvelope{}, err
	}
	if envelope.CurrentTime, text, err = readHeartbeatField(text, "current_time_iso"); err != nil {
		return heartbeatEnvelope{}, err
	}
	if envelope.AutomationID == "" || envelope.CurrentTime == "" {
		return heartbeatEnvelope{}, errors.New("heartbeat identity fields empty")
	}
	return envelope, nil
}

func readHeartbeatField(text, name string) (value, rest string, err error) {
	text = strings.TrimLeftFunc(text, unicode.IsSpace)
	open, close := "<"+name+">", "</"+name+">"
	if !strings.HasPrefix(text, open) {
		return "", text, fmt.Errorf("heartbeat field %s missing", name)
	}
	text = strings.TrimPrefix(text, open)
	end := strings.Index(text, close)
	if end < 0 {
		return "", text, fmt.Errorf("heartbeat field %s unterminated", name)
	}
	value = strings.TrimSpace(text[:end])
	if strings.ContainsAny(value, "<>&") {
		return "", text, fmt.Errorf("heartbeat field %s malformed", name)
	}
	return value, text[end+len(close):], nil
}

func markTurnInvalid(turns map[string]*rolloutTurn, id string) {
	if id != "" {
		if turn := turns[id]; turn != nil {
			turn.invalid = true
		}
	}
}

func invalidRecordWithin(turn *rolloutTurn, records []int) bool {
	if turn.firstRecord == 0 || turn.lastRecord < turn.firstRecord {
		return true
	}
	for _, record := range records {
		if record >= turn.firstRecord && record <= turn.lastRecord {
			return true
		}
	}
	return false
}

func rolloutItemText(raw json.RawMessage) (string, error) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text, nil
	}
	var part struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &part); err == nil && part.Text != "" {
		return part.Text, nil
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err != nil {
		return "", err
	}
	var values []string
	for _, part := range parts {
		values = append(values, part.Text)
	}
	return strings.Join(values, "\n"), nil
}

// OpenRoot confines resolution even if a checked path is changed concurrently.
func openRollout(home, path string) (file *os.File, retErr error) {
	if !filepath.IsAbs(home) || !filepath.IsAbs(path) {
		return nil, errors.New("rollout paths must be absolute")
	}
	// The configured Codex home may itself be a user-managed symlink. Trust that
	// root alias, while refusing symlinks in all untrusted rollout components.
	canonicalHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		return nil, fmt.Errorf("resolve Codex root: %w", err)
	}
	aliasRelative, aliasErr := filepath.Rel(home, path)
	if aliasErr == nil && filepath.IsLocal(aliasRelative) {
		path = filepath.Join(canonicalHome, aliasRelative)
	}
	home = canonicalHome
	rel, err := filepath.Rel(home, path)
	if err != nil {
		return nil, fmt.Errorf("resolve rollout path: %w", err)
	}
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) < 2 || (parts[0] != "sessions" && parts[0] != "archived_sessions") || !filepath.IsLocal(rel) {
		return nil, errors.New("rollout path is outside Codex session directories")
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		return nil, fmt.Errorf("open Codex root: %w", err)
	}
	defer func() {
		if err := root.Close(); err != nil {
			if file != nil {
				retErr = errors.Join(retErr, file.Close())
				file = nil
			}
			retErr = errors.Join(retErr, fmt.Errorf("close Codex root: %w", err))
		}
	}()
	var entry os.FileInfo
	for i := range parts {
		entry, err = root.Lstat(filepath.Join(parts[:i+1]...))
		if err != nil {
			return nil, fmt.Errorf("inspect rollout path: %w", err)
		}
		if entry.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("rollout path contains a symlink")
		}
	}
	f, err := root.Open(rel)
	if err != nil {
		return nil, fmt.Errorf("open rollout: %w", err)
	}
	opened, err := f.Stat()
	if err != nil || !os.SameFile(entry, opened) {
		closeErr := f.Close()
		if err != nil {
			return nil, fmt.Errorf("stat opened rollout: %w", errors.Join(err, closeErr))
		}
		return nil, errors.Join(errors.New("rollout changed during open"), closeErr)
	}
	return f, nil
}
