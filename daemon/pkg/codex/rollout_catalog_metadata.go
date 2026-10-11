package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

var errRolloutReadLimit = errors.New("rollout catalog read byte limit exceeded")

type rolloutBudget struct {
	entries int
	bytes   int64
}

type rolloutBoundedReader struct {
	ctx    context.Context
	reader io.Reader
	budget *rolloutBudget
	bytes  int64
	limit  int64
}

func (r *rolloutBoundedReader) Read(data []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	remaining := min(int64(maxRolloutReadBytes)-r.budget.bytes, r.limit-r.bytes)
	if remaining < 0 {
		return 0, errRolloutReadLimit
	}
	if int64(len(data)) > remaining+1 {
		data = data[:remaining+1]
	}
	n, err := r.reader.Read(data)
	r.bytes += int64(n)
	r.budget.bytes += int64(n)
	if r.bytes > r.limit || r.budget.bytes > maxRolloutReadBytes {
		return 0, errRolloutReadLimit
	}
	if cancelErr := r.ctx.Err(); cancelErr != nil {
		return 0, cancelErr
	}
	return n, err
}

// Only return newline-terminated records. Buffers may pre-read a small block
// after the first newline, but no later rollout record is decoded or exposed.
func readRolloutLine(ctx context.Context, reader *bufio.Reader, limit int) ([]byte, error) {
	line := []byte{}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		part, err := reader.ReadSlice('\n')
		if len(line)+len(part) > limit {
			return nil, rolloutError(ctx, "record byte limit exceeded")
		}
		line = append(line, part...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) && len(line) == 0 {
			return nil, io.EOF
		}
		if errors.Is(err, io.EOF) {
			return nil, rolloutError(ctx, "incomplete record")
		}
		if errors.Is(err, errRolloutReadLimit) {
			return nil, err
		}
		if err != nil {
			return nil, rolloutError(ctx, "record read failed")
		}
		if !utf8.Valid(line) {
			return nil, rolloutError(ctx, "record UTF-8 invalid")
		}
		return bytes.TrimSuffix(line, []byte{'\n'}), nil
	}
}

func validRolloutID(id string) bool {
	return protocol.ValidHistoryIdentity(id) && utf8.ValidString(id) && !strings.ContainsAny(id, `/\`) &&
		!strings.ContainsFunc(id, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) || r == utf8.RuneError })
}

type rolloutFileIdentity struct {
	ThreadID  string
	RolloutID string
	Timestamp time.Time
}

func parseRolloutUUID(id string) (string, bool) {
	const uuidLength = 36
	if len(id) != uuidLength {
		return "", false
	}
	for i, character := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if character != '-' {
				return "", false
			}
		} else if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f' || character >= 'A' && character <= 'F') {
			return "", false
		}
	}
	return strings.ToLower(id), true
}

func parseRolloutFilename(filename string) (rolloutFileIdentity, bool) {
	var empty rolloutFileIdentity
	const prefix = "rollout-"
	const suffix = ".jsonl"
	const timestampLayout = "2006-01-02T15-04-05"
	if !strings.HasPrefix(filename, prefix) || !strings.HasSuffix(filename, suffix) {
		return empty, false
	}
	stem := strings.TrimSuffix(strings.TrimPrefix(filename, prefix), suffix)
	separator := len(timestampLayout)
	if len(stem) <= separator || stem[separator] != '-' {
		return empty, false
	}
	timestamp, err := time.Parse(timestampLayout, stem[:separator])
	if err != nil {
		return empty, false
	}
	threadText, rolloutText, compound := strings.Cut(stem[separator+1:], "_")
	threadID, valid := parseRolloutUUID(threadText)
	if !valid {
		return empty, false
	}
	rolloutID := threadID
	if compound {
		rolloutID, valid = parseRolloutUUID(rolloutText)
		if !valid {
			return empty, false
		}
	}
	return rolloutFileIdentity{ThreadID: threadID, RolloutID: rolloutID, Timestamp: timestamp.UTC()}, true
}

func rolloutString(raw json.RawMessage, required bool) (string, error) {
	if !required && (len(raw) == 0 || bytes.Equal(raw, []byte("null"))) {
		return "", nil
	}
	var value string
	if len(raw) == 0 || json.Unmarshal(raw, &value) != nil || bytes.Equal(raw, []byte("null")) {
		return "", errors.New("unsupported metadata schema")
	}
	return value, nil
}

func readRolloutHeader(ctx context.Context, root *os.Root, path, observedAt string, budget *rolloutBudget) (record rolloutRecord, include bool, err error) {
	file, err := openRolloutFile(ctx, root, path, false)
	if err != nil {
		return record, false, err
	}
	defer func() {
		err = errors.Join(err, rolloutClose(ctx, file))
		if err != nil {
			include = false
		}
	}()
	info, err := file.Stat()
	if err != nil {
		return record, false, rolloutError(ctx, "metadata stat failed")
	}
	reader := bufio.NewReaderSize(&rolloutBoundedReader{ctx: ctx, reader: file, budget: budget, limit: maxRolloutHeaderBytes + rolloutReadBufferBytes}, rolloutReadBufferBytes)
	header, err := readRolloutLine(ctx, reader, maxRolloutHeaderBytes)
	if err != nil {
		if errors.Is(err, io.EOF) {
			err = rolloutError(ctx, "metadata header missing")
		}
		return record, false, err
	}
	record, include, err = parseRolloutHeader(ctx, header, filepath.Base(path), observedAt)
	if include {
		record.Modified = info.ModTime().UTC().Format(time.RFC3339Nano)
	}
	return record, include, err
}

func parseRolloutHeader(ctx context.Context, header []byte, filename, observedAt string) (rolloutRecord, bool, error) {
	var empty rolloutRecord
	var envelope struct {
		Type    string                     `json:"type"`
		Payload map[string]json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(header, &envelope); err != nil || envelope.Type != "session_meta" || envelope.Payload == nil {
		return empty, false, rolloutError(ctx, "metadata schema invalid")
	}
	payload := envelope.Payload
	if len(payload["source"]) == 0 {
		return empty, false, rolloutError(ctx, "metadata source missing")
	}
	source, sourceErr := rolloutString(payload["source"], true)
	if sourceErr != nil || source != "cli" && source != "vscode" && source != "appServer" {
		return empty, false, nil
	}
	parent, err := rolloutString(payload["parent_thread_id"], false)
	if err != nil {
		return empty, false, rolloutError(ctx, "metadata parent schema invalid")
	}
	if parent != "" {
		return empty, false, nil
	}
	id, idErr := rolloutString(payload["id"], true)
	cwd, cwdErr := rolloutString(payload["cwd"], true)
	provider, providerErr := rolloutString(payload["model_provider"], false)
	timestamp, timestampErr := rolloutString(payload["timestamp"], true)
	if errors.Join(idErr, cwdErr, providerErr, timestampErr) != nil {
		return empty, false, rolloutError(ctx, "metadata field schema invalid")
	}
	identity, validFilename := parseRolloutFilename(filename)
	nativeID, validUUID := parseRolloutUUID(id)
	if !validRolloutID(id) || !validUUID || !validFilename || nativeID != identity.ThreadID {
		return empty, false, rolloutError(ctx, "metadata identity mismatch")
	}
	if !filepath.IsAbs(cwd) || strings.ContainsFunc(cwd, unicode.IsControl) {
		return empty, false, rolloutError(ctx, "metadata cwd invalid")
	}
	parsed, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		return empty, false, rolloutError(ctx, "metadata timestamp invalid")
	}
	loaded := false
	return rolloutRecord{Session: protocol.Session{
		ID: nativeID, Provider: ProviderCodexApp, Cwd: clipHistoryText(cwd, maxSessionMetadataLength),
		ModelProvider: clipHistoryText(provider, protocol.MaxHistoryIdentityLength),
		Status:        "unknown", Loaded: &loaded, Capabilities: []protocol.ActionType{protocol.ActionRead}, ObservedAt: observedAt,
	}, Timestamp: parsed.UTC().Format(time.RFC3339Nano), FileTimestamp: identity.Timestamp, RolloutID: identity.RolloutID}, true, nil
}

func applyRolloutTitles(ctx context.Context, root *os.Root, records []rolloutRecord, budget *rolloutBudget) (err error) {
	// Lstat only distinguishes an absent optional index from an existing index
	// disappearing during open. Type safety still uses nonblocking open+fstat.
	info, err := root.Lstat("session_index.jsonl")
	if errors.Is(err, os.ErrNotExist) {
		return ctx.Err()
	}
	if err != nil {
		return rolloutError(ctx, "index unavailable")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return rolloutError(ctx, "index symlink rejected")
	}
	file, err := openRolloutFile(ctx, root, "session_index.jsonl", false)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, rolloutClose(ctx, file)) }()
	byID := make(map[string]int)
	for i, record := range records {
		byID[record.Session.ID] = i
	}
	latest := make(map[string]time.Time)
	reader := bufio.NewReaderSize(&rolloutBoundedReader{ctx: ctx, reader: file, budget: budget, limit: maxRolloutIndexBytes}, rolloutReadBufferBytes)
	for count := 0; ; count++ {
		line, err := readRolloutLine(ctx, reader, maxRolloutIndexLineBytes)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if count >= maxRolloutIndexRecords {
			return rolloutError(ctx, "index record limit exceeded")
		}
		var entry struct {
			ID         string  `json:"id"`
			ThreadName *string `json:"thread_name"`
			UpdatedAt  string  `json:"updated_at"`
		}
		if err := json.Unmarshal(line, &entry); err != nil || !validRolloutID(entry.ID) || entry.ThreadName == nil {
			return rolloutError(ctx, "index schema invalid")
		}
		if nativeID, valid := parseRolloutUUID(entry.ID); valid {
			entry.ID = nativeID
		}
		updated, err := time.Parse(time.RFC3339Nano, entry.UpdatedAt)
		if err != nil {
			return rolloutError(ctx, "index timestamp invalid")
		}
		i, exists := byID[entry.ID]
		if exists && !updated.Before(latest[entry.ID]) {
			records[i].Session.Title = clipHistoryText(*entry.ThreadName, maxSessionMetadataLength)
			latest[entry.ID] = updated
		}
	}
}
