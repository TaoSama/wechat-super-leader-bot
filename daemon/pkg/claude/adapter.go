package claude

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/transcript"
)

const (
	StatusIdle    = "idle"
	StatusActive  = "active"
	StatusUnknown = "unknown"

	maxRetainedRuns = 1024
)

// ErrBusy reports a definite refusal: no process was started and no input sent.
var ErrBusy = errors.New("Claude Code session is busy or open in another process; no input sent")

// Adapter owns daemon-launched runs. Each session has at most one run, and a
// preflight under the same lock rejects sessions another process holds.
type Adapter struct {
	cfg        Config
	env        []string
	history    *transcript.Reader
	launchMu   sync.Mutex
	sessionMu  map[string]*sync.Mutex
	mu         sync.Mutex
	runs       map[string]*run // by turn ID
	active     map[string]*run // by public session ID
	finished   map[string]time.Time
	heads      map[string]headMetadata
	closed     bool
	now        func() time.Time
	listLiveFn func(context.Context) (liveSessions, error)
}

func New(cfg Config) (*Adapter, error) {
	cfg = cfg.WithDefaults()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	configDir, err := cfg.configDirOverride()
	if err != nil {
		return nil, err
	}
	a := &Adapter{cfg: cfg, env: runEnv(daemonEnv(), configDir), sessionMu: map[string]*sync.Mutex{},
		history: transcript.New(transcript.Config{Roots: map[string]string{transcriptAgent: cfg.ProjectsRoot}}),
		runs:    map[string]*run{}, active: map[string]*run{}, finished: map[string]time.Time{},
		heads: map[string]headMetadata{}, now: time.Now}
	a.listLiveFn = a.listLive
	return a, nil
}

// Endpoint identifies the executable bound into a durable dispatch identity.
func (a *Adapter) Endpoint() string { return a.cfg.ClaudePath }

func PublicID(nativeID string) string { return protocol.ClaudeSessionPrefix + nativeID }

func nativeID(publicID string) (string, bool) {
	id, found := strings.CutPrefix(publicID, protocol.ClaudeSessionPrefix)
	return id, found && sessionUUID.MatchString(id)
}

func IsSession(publicID string) bool {
	return strings.HasPrefix(publicID, protocol.ClaudeSessionPrefix)
}

func (a *Adapter) lockFor(publicID string) *sync.Mutex {
	a.launchMu.Lock()
	defer a.launchMu.Unlock()
	lock, ok := a.sessionMu[publicID]
	if !ok {
		lock = &sync.Mutex{}
		a.sessionMu[publicID] = lock
	}
	return lock
}

// Running reports whether this daemon has a turn in progress for the session.
func (a *Adapter) Running(publicID string) bool { return a.running(publicID) }

func (a *Adapter) running(publicID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	current, ok := a.active[publicID]
	if !ok {
		return false
	}
	select {
	case <-current.done:
		return false
	default:
		return true
	}
}

// metadata returns the cached head of an append-only transcript or reads it.
func (a *Adapter) metadata(info transcriptInfo) (transcriptInfo, error) {
	a.mu.Lock()
	cached, ok := a.heads[info.Path]
	a.mu.Unlock()
	if !ok || info.Size < cached.size {
		cwd, title, err := readHead(info.Path, info.ID)
		if err != nil {
			return info, err
		}
		cached = headMetadata{cwd: cwd, title: title}
	}
	cached.size, cached.modTime = info.Size, info.UpdatedAt
	a.mu.Lock()
	a.heads[info.Path] = cached
	a.mu.Unlock()
	if !projectMatchesCwd(filepath.Base(filepath.Dir(info.Path)), cached.cwd) {
		return info, errors.New("transcript directory does not match its working directory")
	}
	info.Cwd, info.Title = cached.cwd, cached.title
	return info, nil
}

// status is idle only when nothing indicates another writer.
func (a *Adapter) status(info transcriptInfo, live liveSessions, liveErr error, now time.Time) string {
	switch {
	case a.running(PublicID(info.ID)):
		return StatusActive
	case liveErr != nil:
		return StatusUnknown
	case live.holds(info.ID, info.Cwd), a.recentlyWritten(info, now):
		return StatusActive
	}
	return StatusIdle
}

// recentlyWritten ignores writes made by this daemon's own finished run: that
// process has exited, so it cannot interleave with the next turn.
func (a *Adapter) recentlyWritten(info transcriptInfo, now time.Time) bool {
	a.mu.Lock()
	finished, ok := a.finished[PublicID(info.ID)]
	a.mu.Unlock()
	if ok && !info.UpdatedAt.After(finished) {
		return false
	}
	return now.Sub(info.UpdatedAt) < a.cfg.ActivityWindow
}

func (a *Adapter) DiscoverSessions(ctx context.Context) ([]protocol.Session, error) {
	found, err := scanTranscripts(a.cfg.ProjectsRoot)
	if err != nil {
		return nil, err
	}
	live, liveErr := a.listLiveFn(ctx)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	now := a.now()
	observed := now.UTC().Format(time.RFC3339Nano)
	sessions := make([]protocol.Session, 0, len(found))
	kept := make(map[string]bool, len(found))
	for _, candidate := range found {
		info, err := a.metadata(candidate)
		if err != nil {
			continue
		}
		kept[info.Path] = true
		loaded := false
		title := info.Title
		if title == "" {
			title = filepath.Base(info.Cwd)
		}
		sessions = append(sessions, protocol.Session{
			ID: PublicID(info.ID), Provider: ProviderClaudeCode, Title: title, Cwd: info.Cwd,
			Status: a.status(info, live, liveErr, now), Loaded: &loaded, ObservedAt: observed,
			UpdatedAt:    info.UpdatedAt.UTC().Format(time.RFC3339Nano),
			Capabilities: []protocol.ActionType{protocol.ActionRead, protocol.CapabilityResumeSend},
		})
	}
	a.mu.Lock()
	for path := range a.heads {
		if !kept[path] {
			delete(a.heads, path)
		}
	}
	a.mu.Unlock()
	return sessions, nil
}

// locate finds the unique transcript for an exact session ID.
func (a *Adapter) locate(id string) (transcriptInfo, error) {
	projects, err := os.ReadDir(a.cfg.ProjectsRoot)
	if err != nil {
		return transcriptInfo{}, err
	}
	var match *transcriptInfo
	for _, project := range projects {
		if project.Type()&os.ModeType != os.ModeDir {
			continue
		}
		path := filepath.Join(a.cfg.ProjectsRoot, project.Name(), id+transcriptSuffix)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || match != nil {
			return transcriptInfo{}, errors.New("Claude Code transcript is ambiguous or not a regular file")
		}
		match = &transcriptInfo{ID: id, Path: path, UpdatedAt: info.ModTime(), Size: info.Size()}
	}
	if match == nil {
		return transcriptInfo{}, errors.New("Claude Code transcript not found")
	}
	return a.metadata(*match)
}

// Send starts exactly one resumed headless turn and returns once the prompt
// has been handed to the CLI. The run continues after ctx ends.
func (a *Adapter) Send(ctx context.Context, publicID, turnID, prompt string) error {
	id, ok := nativeID(publicID)
	if !ok || !protocol.ValidTurnID(turnID) {
		return errors.New("invalid Claude Code session or turn identity")
	}
	lock := a.lockFor(publicID)
	lock.Lock()
	defer lock.Unlock()
	if a.running(publicID) {
		return ErrBusy
	}
	info, err := a.locate(id)
	if err != nil {
		return fmt.Errorf("%w; no input sent", err)
	}
	if dir, err := os.Stat(info.Cwd); err != nil || !dir.IsDir() {
		return errors.New("Claude Code session working directory is unavailable; no input sent")
	}
	live, err := a.listLiveFn(ctx)
	if err != nil {
		return errors.New("Claude Code live session check unavailable; no input sent")
	}
	if live.holds(id, info.Cwd) || a.recentlyWritten(info, a.now()) {
		return ErrBusy
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("command expired before launch; no input sent: %w", err)
	}
	return a.launch(publicID, id, turnID, info.Cwd, prompt)
}

func (a *Adapter) args(id string) []string {
	return []string{"-p", "--resume", id, "--output-format", "stream-json", "--verbose",
		"--permission-mode", a.cfg.PermissionMode, "--permission-prompts", "none"}
}

func (a *Adapter) launch(publicID, id, turnID, cwd, prompt string) error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return errors.New("Claude Code adapter is shutting down; no input sent")
	}
	if _, exists := a.runs[turnID]; exists {
		a.mu.Unlock()
		return errors.New("Claude Code turn identity already used; no input sent")
	}
	a.mu.Unlock()
	cmd := exec.Command(a.cfg.ClaudePath, a.args(id)...)
	cmd.Dir, cmd.Env = cwd, a.env
	isolateProcessGroup(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("prepare Claude Code input: %w; no input sent", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("prepare Claude Code output: %w; no input sent", err)
	}
	stderr := &boundedBuffer{limit: maxStderrBytes}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start Claude Code: %w; no input sent", err)
	}
	r := &run{sessionID: publicID, turnID: turnID, cmd: cmd, done: make(chan struct{}),
		observation: codex.TurnObservation{Status: TurnInProgress}}
	a.mu.Lock()
	a.pruneLocked()
	a.runs[turnID], a.active[publicID] = r, r
	a.mu.Unlock()
	go a.supervise(r, stdout, stderr, id)
	_, writeErr := io.WriteString(stdin, prompt)
	closeErr := stdin.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		a.interrupt(r)
		return &codex.UncertainError{Err: fmt.Errorf("Claude Code prompt delivery failed; outcome unconfirmed: %w", err)}
	}
	return nil
}

// pruneLocked forgets the oldest finished runs once the retention bound is hit.
// The journal holds their durable receipts by then.
func (a *Adapter) pruneLocked() {
	if len(a.runs) < maxRetainedRuns {
		return
	}
	var oldest *run
	for _, candidate := range a.runs {
		select {
		case <-candidate.done:
			if oldest == nil || candidate.endedAt.Before(oldest.endedAt) {
				oldest = candidate
			}
		default:
		}
	}
	if oldest != nil {
		delete(a.runs, oldest.turnID)
	}
}

// markFinished records when a run's process exited.
func (a *Adapter) markFinished(r *run, at time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.finished[r.sessionID] = at
	if a.active[r.sessionID] == r {
		delete(a.active, r.sessionID)
	}
}

// InspectTurn reports only a run this daemon process launched.
func (a *Adapter) InspectTurn(_ context.Context, publicID, turnID string) (codex.TurnObservation, error) {
	a.mu.Lock()
	r, ok := a.runs[turnID]
	a.mu.Unlock()
	if !ok || r.sessionID != publicID {
		return codex.TurnObservation{}, errors.New("Claude Code turn is not owned by this daemon process")
	}
	observation := r.snapshot()
	if observation.Error == protocol.ErrTurnOutputLimit.Error() {
		return codex.TurnObservation{}, protocol.ErrTurnOutputLimit
	}
	return observation, nil
}

// Done returns a channel closed when the turn's final observation is recorded.
func (a *Adapter) Done(turnID string) (<-chan struct{}, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	r, ok := a.runs[turnID]
	if !ok {
		return nil, false
	}
	return r.done, true
}

// Close stops every run. Their outcomes remain unconfirmed and are never replayed.
func (a *Adapter) Close() {
	a.mu.Lock()
	a.closed = true
	runs := make([]*run, 0, len(a.active))
	for _, r := range a.active {
		runs = append(runs, r)
	}
	a.mu.Unlock()
	for _, r := range runs {
		select {
		case <-r.done:
			continue
		default:
		}
		r.mu.Lock()
		r.stopped = true
		r.mu.Unlock()
		a.interrupt(r)
	}
	for _, r := range runs {
		<-r.done
	}
}
