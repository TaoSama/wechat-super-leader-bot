package rollout

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	maxRolloutHeaderBytes    = 256 * 1024
	maxRolloutReadBytes      = 256 * 1024 * 1024
	maxRolloutEntries        = 50000
	maxRolloutSessions       = 5000
	maxRolloutFrameBytes     = protocol.MaxControllerMessageBytes - threadstate.HistoryEnvelopeReserveBytes
	rolloutDirectoryBatch    = 64
	rolloutReadBufferBytes   = 4096
	maxRolloutIndexLineBytes = 64 * 1024
	maxRolloutIndexBytes     = 16 * 1024 * 1024
	maxRolloutIndexRecords   = 10000
	rolloutSummaryNotice     = "仅持久化文件元数据，非 live；历史未读取。文件修改时间和标题索引时间不代表会话执行状态。只读元数据不授权发送、恢复或创建会话。"
)

// RolloutCatalog is an independent metadata-only reader, not an execution or
// history adapter. It retains no file paths, identities, or results across calls.
type RolloutCatalog struct{ codexHome string }

func NewRolloutCatalog(codexHome string) *RolloutCatalog {
	return &RolloutCatalog{codexHome: codexHome}
}

type rolloutRecord struct {
	Session       protocol.Session
	Timestamp     string
	Modified      string
	FileTimestamp time.Time
	RolloutID     string
}

type rolloutOrderingKey struct {
	ThreadID  string
	Timestamp time.Time
	RolloutID string
}

func rolloutError(ctx context.Context, reason string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return errors.New("rollout catalog " + reason)
}

func rolloutClose(ctx context.Context, closer io.Closer) error {
	if err := closer.Close(); err != nil {
		return rolloutError(ctx, "close failed")
	}
	return nil
}

func (c *RolloutCatalog) read(ctx context.Context) (records []rolloutRecord, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(c.codexHome) {
		return nil, rolloutError(ctx, "requires an absolute home directory")
	}
	home, err := openRolloutRoot(ctx, nil, c.codexHome)
	if err != nil {
		return nil, err
	}
	defer func() {
		err = errors.Join(err, rolloutClose(ctx, home))
		if err != nil {
			records = nil
		}
	}()
	sessions, err := openRolloutRoot(ctx, home, "sessions")
	if err != nil {
		return nil, err
	}
	defer func() {
		err = errors.Join(err, rolloutClose(ctx, sessions))
		if err != nil {
			records = nil
		}
	}()
	budget := &rolloutBudget{}
	observedAt := time.Now().UTC().Format(time.RFC3339Nano)
	records = []rolloutRecord{}
	byID := make(map[string]int)
	seenKeys := make(map[rolloutOrderingKey]struct{})
	err = walkRolloutDates(ctx, sessions, ".", 0, budget, func(path string) error {
		record, include, err := readRolloutHeader(ctx, sessions, path, observedAt, budget)
		if err != nil || !include {
			return err
		}
		key := rolloutOrderingKey{record.Session.ID, record.FileTimestamp, record.RolloutID}
		if _, exists := seenKeys[key]; exists {
			return rolloutError(ctx, "duplicate file ordering key")
		}
		seenKeys[key] = struct{}{}
		if i, exists := byID[record.Session.ID]; exists {
			previous := records[i]
			if record.FileTimestamp.After(previous.FileTimestamp) || record.FileTimestamp.Equal(previous.FileTimestamp) && record.RolloutID > previous.RolloutID {
				records[i] = record
			}
			return nil
		}
		if len(records) >= maxRolloutSessions {
			return rolloutError(ctx, "session limit exceeded")
		}
		byID[record.Session.ID] = len(records)
		records = append(records, record)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := applyRolloutTitles(ctx, home, records, budget); err != nil {
		return nil, err
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Session.ID < records[j].Session.ID })
	encodedBytes := 2
	for _, record := range records {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(record.Session)
		if err != nil {
			return nil, rolloutError(ctx, "metadata encoding failed")
		}
		encodedBytes += len(encoded) + 1
		if encodedBytes > maxRolloutFrameBytes {
			return nil, rolloutError(ctx, "metadata frame limit exceeded")
		}
	}
	return records, ctx.Err()
}

func (c *RolloutCatalog) DiscoverSessions(ctx context.Context) ([]protocol.Session, error) {
	records, err := c.read(ctx)
	if err != nil {
		return nil, err
	}
	sessions := make([]protocol.Session, 0, len(records))
	for _, record := range records {
		sessions = append(sessions, record.Session)
	}
	return sessions, nil
}

// ReadSession repeats discovery inside the sessions subroot; moving a rollout
// to archived_sessions cannot keep a previously discovered identity readable.
func (c *RolloutCatalog) ReadSession(ctx context.Context, id string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if !validRolloutID(id) {
		return "", rolloutError(ctx, "session identity invalid")
	}
	records, err := c.read(ctx)
	if err != nil {
		return "", err
	}
	for _, record := range records {
		if record.Session.ID != id {
			continue
		}
		metadata, err := json.MarshalIndent(struct {
			Session                  protocol.Session `json:"session"`
			SessionMetadataTimestamp string           `json:"sessionMetadataTimestamp"`
			RolloutFileModifiedAt    string           `json:"rolloutFileModifiedAt"`
		}{record.Session, record.Timestamp, record.Modified}, "", "  ")
		if err != nil {
			return "", rolloutError(ctx, "metadata encoding failed")
		}
		return fmt.Sprintf("%s\n%s", rolloutSummaryNotice, metadata), ctx.Err()
	}
	return "", rolloutError(ctx, "session metadata unavailable")
}

func walkRolloutDates(ctx context.Context, root *os.Root, path string, depth int, budget *rolloutBudget, visit func(string) error) (err error) {
	dir, err := openRolloutFile(ctx, root, path, true)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, rolloutClose(ctx, dir)) }()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		entries, readErr := dir.ReadDir(rolloutDirectoryBatch)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return rolloutError(ctx, "directory read failed")
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			budget.entries++
			if budget.entries > maxRolloutEntries {
				return rolloutError(ctx, "directory entry limit exceeded")
			}
			name := entry.Name()
			if depth < 3 && !rolloutDateComponent(name, depth) || depth == 3 && (!strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl")) {
				continue
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return rolloutError(ctx, "symlink entry rejected")
			}
			next := filepath.Join(path, name)
			if depth < 3 {
				if depth == 2 {
					if _, err := time.Parse("2006/01/02", filepath.ToSlash(next)); err != nil {
						continue
					}
				}
				if err := walkRolloutDates(ctx, root, next, depth+1, budget, visit); err != nil {
					return err
				}
			} else if err := visit(next); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
	}
}

func rolloutDateComponent(name string, depth int) bool {
	want := 2
	if depth == 0 {
		want = 4
	}
	if len(name) != want {
		return false
	}
	for _, char := range name {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}
