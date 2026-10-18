// Package automation provides bounded, read-only evidence from native Codex automations.
package automation

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
	_ "modernc.org/sqlite"
)

const MaxAutomations = 128
const MaxResultBytes = 256 * 1024
const maxConfigBytes = 128 * 1024
const maxRunRows = 512

var validID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
var ErrTooLarge = errors.New("automation_result_too_large")

type Config struct {
	ID              string `json:"id" toml:"id"`
	Name            string `json:"name" toml:"name"`
	Kind            string `json:"kind" toml:"kind"`
	Status          string `json:"status" toml:"status"`
	Prompt          string `json:"prompt" toml:"prompt"`
	RRule           string `json:"rrule" toml:"rrule"`
	TargetSessionID string `json:"targetSessionId,omitempty" toml:"target_thread_id"`
	NextRunAt       *int64 `json:"nextRunAt,omitempty" toml:"-"`
	LastRunAt       *int64 `json:"lastRunAt,omitempty" toml:"-"`
}
type Inspection struct {
	AutomationID string   `json:"automationId"`
	ExpectedAt   int64    `json:"expectedAt"`
	NotAfter     int64    `json:"notAfter"`
	Status       string   `json:"status"`
	SessionID    string   `json:"sessionId,omitempty"`
	TurnID       string   `json:"turnId,omitempty"`
	Text         string   `json:"text,omitempty"`
	Sources      []string `json:"sources"`
	ObservedAt   int64    `json:"observedAt"`
	Reason       string   `json:"reason,omitempty"`
}
type Reader struct{ Home string }

func ValidWindow(id string, expectedAt, notAfter int64) bool {
	return validID.MatchString(id) && expectedAt > 0 && notAfter >= expectedAt && notAfter-expectedAt <= int64(7*24*time.Hour/time.Millisecond) && notAfter <= 9007199254740991
}
func (r Reader) config(ctx context.Context, id string) (result Config, retErr error) {
	if !validID.MatchString(id) || !filepath.IsAbs(r.Home) {
		return result, errors.New("automation_invalid_request")
	}
	root, err := os.OpenRoot(r.Home)
	if err != nil {
		return result, errors.New("automation_home_unavailable")
	}
	defer func() { retErr = errors.Join(retErr, root.Close()) }()
	f, err := root.Open(filepath.Join("automations", id, "automation.toml"))
	if err != nil {
		return result, errors.New("automation_config_unavailable")
	}
	defer func() { retErr = errors.Join(retErr, f.Close()) }()
	b, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	if err != nil {
		return result, err
	}
	if len(b) > maxConfigBytes {
		return result, ErrTooLarge
	}
	if err = toml.Unmarshal(b, &result); err != nil {
		return result, errors.New("automation_config_unsupported")
	}
	if result.ID != id || (result.Kind != "heartbeat" && result.Kind != "cron") || len(result.Name) > 512 || len(result.Prompt) > 65536 || len(result.RRule) > 2048 || len(result.Status) > 32 || len(result.TargetSessionID) > 128 {
		return result, errors.New("automation_config_unsupported")
	}
	return result, ctx.Err()
}
func openDB(ctx context.Context, path string, table string, columns []string) (*sql.DB, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("automation_database_unavailable")
	}
	u := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro&_pragma=query_only(1)&_pragma=busy_timeout(1000)"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err = checkSchema(ctx, db, table, columns); err != nil {
		return nil, errors.Join(err, db.Close())
	}
	return db, nil
}
func checkSchema(ctx context.Context, db *sql.DB, table string, columns []string) (retErr error) {
	// Identifiers are internal constants. All external identities use SQL parameters.
	rows, err := db.QueryContext(ctx, "pragma table_info("+table+")")
	if err != nil {
		return errors.New("automation_schema_unsupported")
	}
	defer func() { retErr = errors.Join(retErr, rows.Close()) }()
	found := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, kind string
		var def any
		if err = rows.Scan(&cid, &name, &kind, &notnull, &def, &pk); err != nil {
			return err
		}
		found[name] = true
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, c := range columns {
		if !found[c] {
			return errors.New("automation_schema_unsupported")
		}
	}
	return nil
}
func (r Reader) database(ctx context.Context) (*sql.DB, error) {
	if !filepath.IsAbs(r.Home) {
		return nil, errors.New("automation_home_unavailable")
	}
	return openDB(ctx, filepath.Join(r.Home, "sqlite", "codex-dev.db"), "automations", []string{"id", "kind", "target_thread_id", "last_run_at", "next_run_at"})
}
func hydrate(ctx context.Context, db *sql.DB, c *Config) error {
	var kind string
	var target sql.NullString
	var last, next sql.NullInt64
	if err := db.QueryRowContext(ctx, "select kind,target_thread_id,last_run_at,next_run_at from automations where id=?", c.ID).Scan(&kind, &target, &last, &next); err != nil {
		return errors.New("automation_database_config_missing")
	}
	if kind != c.Kind || target.String != c.TargetSessionID {
		return errors.New("automation_config_database_mismatch")
	}
	if last.Valid {
		c.LastRunAt = &last.Int64
	}
	if next.Valid {
		c.NextRunAt = &next.Int64
	}
	return nil
}
func (r Reader) List(ctx context.Context) (result []Config, retErr error) {
	db, err := r.database(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { retErr = errors.Join(retErr, db.Close()) }()
	rows, err := db.QueryContext(ctx, "select id from automations order by id limit ?", MaxAutomations+1)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, errors.Join(err, rows.Close())
		}
		ids[id] = true
	}
	if err = errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	if len(ids) > MaxAutomations {
		return nil, ErrTooLarge
	}
	result = []Config{}
	root, err := os.OpenRoot(r.Home)
	if err != nil {
		return nil, errors.New("automation_home_unavailable")
	}
	defer func() { retErr = errors.Join(retErr, root.Close()) }()
	dir, err := root.Open("automations")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && len(ids) == 0 {
			return result, nil
		}
		return nil, errors.New("automation_config_unavailable")
	}
	defer func() { retErr = errors.Join(retErr, dir.Close()) }()
	entries, err := dir.ReadDir(MaxAutomations + 2)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > MaxAutomations+1 {
		return nil, ErrTooLarge
	}
	for _, entry := range entries {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		if !entry.IsDir() {
			continue
		}
		if len(result) >= MaxAutomations {
			return nil, ErrTooLarge
		}
		c, err := r.config(ctx, entry.Name())
		if err != nil {
			return nil, err
		}
		if err = hydrate(ctx, db, &c); err != nil {
			return nil, err
		}
		delete(ids, c.ID)
		result = append(result, c)
	}
	if len(ids) > 0 {
		return nil, errors.New("automation_config_database_mismatch")
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}
func (r Reader) Inspect(ctx context.Context, id string, expectedAt, notAfter int64) (out Inspection, retErr error) {
	out = Inspection{AutomationID: id, ExpectedAt: expectedAt, NotAfter: notAfter, Status: "unknown", Sources: []string{}, ObservedAt: time.Now().UnixMilli()}
	if !ValidWindow(id, expectedAt, notAfter) {
		return out, errors.New("automation_invalid_request")
	}
	fail := func(err error) (Inspection, error) {
		if errors.Is(err, ErrTooLarge) || ctx.Err() != nil {
			return out, err
		}
		out.Reason = err.Error()
		if !strings.HasPrefix(out.Reason, "automation_") || len(out.Reason) > 256 {
			out.Reason = "automation_evidence_unavailable"
		}
		return out, nil
	}
	config, err := r.config(ctx, id)
	if err != nil {
		return fail(err)
	}
	db, err := r.database(ctx)
	if err != nil {
		return fail(err)
	}
	defer func() { retErr = errors.Join(retErr, db.Close()) }()
	if err = hydrate(ctx, db, &config); err != nil {
		return fail(err)
	}
	out.Sources = append(out.Sources, "automation.toml:"+id, "sqlite:automations/"+id)
	sessionID := config.TargetSessionID
	if config.Kind == "cron" {
		if err = checkSchema(ctx, db, "automation_runs", []string{"thread_id", "automation_id", "created_at"}); err != nil {
			return fail(err)
		}
		// Native schemas have no automation_id index. Bound work by the rowid index,
		// rather than scanning the entire runs table for every monitor check.
		rows, err := db.QueryContext(ctx, "select thread_id,automation_id,created_at from automation_runs order by rowid desc limit ?", maxRunRows+1)
		if err != nil {
			return fail(err)
		}
		ids := []string{}
		count := 0
		for rows.Next() {
			var sid, aid string
			var created int64
			if err = rows.Scan(&sid, &aid, &created); err != nil {
				return fail(errors.Join(err, rows.Close()))
			}
			count++
			if aid == id && created >= expectedAt && created <= notAfter {
				ids = append(ids, sid)
			}
		}
		err = errors.Join(rows.Err(), rows.Close())
		if err != nil {
			return fail(err)
		}
		if count > maxRunRows {
			out.Reason = "automation_run_scan_limit"
			return out, nil
		}
		if len(ids) == 0 {
			out.Status = "waiting"
			out.Reason = "no_matching_run"
			return out, nil
		}
		if len(ids) > 1 {
			out.Reason = "ambiguous_run"
			return out, nil
		}
		sessionID = ids[0]
		out.Sources = append(out.Sources, "sqlite:automation_runs/"+sessionID)
	}
	if !validID.MatchString(sessionID) {
		return fail(errors.New("automation_target_unavailable"))
	}
	out.SessionID = sessionID
	state, err := openDB(ctx, filepath.Join(r.Home, "state_5.sqlite"), "threads", []string{"id", "rollout_path"})
	if err != nil {
		return fail(err)
	}
	defer func() { retErr = errors.Join(retErr, state.Close()) }()
	var path string
	if err = state.QueryRowContext(ctx, "select rollout_path from threads where id=?", sessionID).Scan(&path); err != nil {
		return fail(errors.New("automation_thread_unavailable"))
	}
	evidence, err := inspectRollout(ctx, r.Home, path, sessionID, id, expectedAt, notAfter, config.Kind == "heartbeat")
	if err != nil {
		return fail(err)
	}
	out.Status, out.TurnID, out.Text, out.Reason = evidence.Status, evidence.TurnID, evidence.Text, evidence.Reason
	out.Sources = append(out.Sources, evidence.Sources...)
	if len(out.Text) > MaxResultBytes {
		return out, ErrTooLarge
	}
	return out, nil
}
