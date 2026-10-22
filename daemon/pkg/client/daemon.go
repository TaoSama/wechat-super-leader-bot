package client

import (
	"log"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	codexdesktop "github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/desktop"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/rollout"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/transcript"
)

const (
	MinReconnectBackoff = 500 * time.Millisecond
	MaxReconnectBackoff = 15 * time.Second
	CommandExecTimeout  = 30 * time.Second
	MaxDedupeEntries    = 2048
)

type dedupeEntry struct {
	result      protocol.DaemonResultMessage
	fingerprint string
}

// Daemon manages the outbound WebSocket connection to Controller and dispatches commands to the SessionAdapter.
type Daemon struct {
	cfg     *config.Config
	adapter codex.SessionAdapter

	dedupeMu    sync.Mutex
	dedupeCache map[string]dedupeEntry
	dedupeOrder []string

	sessionLocksMu sync.Mutex
	sessionLocks   map[string]*sync.Mutex

	// In-flight command tracking to prevent concurrent execution of the same commandId across sessions
	inFlightMu sync.Mutex
	inFlight   map[string]chan struct{}

	outboxMu           sync.Mutex
	outbox             map[string]protocol.DaemonResultMessage
	journal            commandJournal
	durableJournal     bool
	persistenceMu      sync.Mutex
	pendingPersistence map[string]protocol.DaemonResultMessage
	workers            sync.WaitGroup
	snapshotMu         sync.RWMutex
	sessionSnapshot    []protocol.Session
	sessionCatalog     sessionCatalog
	catalogSnapshot    []protocol.Session
	managedCatalog     map[string]protocol.Session
	terminalObserver   sessionCatalog
	terminalHistory    terminalHistoryReader
	terminalSnapshot   []protocol.Session
	terminalDiscovery  chan struct{}
	terminalController *terminal.DeliveryController
	terminalReadiness  map[string]terminalReadinessRecord
	desktopObserver    codexdesktop.DesktopWatcher
	desktopController  desktopController
	desktopSnapshot    map[string]protocol.DesktopObservation
	sendReadiness      map[string]desktopReadinessRecord
	desktopGeneration  map[string]uint64
	desktopEpoch       uint64
	desktopHistory     desktopHistoryReader
	historyContexts    *historyContexts
	historyRequests    *historyRequests
	mediaState         *mediaState
}

func NewDaemon(cfg *config.Config, adapter codex.SessionAdapter) *Daemon {
	d := &Daemon{
		cfg:                cfg,
		adapter:            adapter,
		dedupeCache:        make(map[string]dedupeEntry),
		sessionLocks:       make(map[string]*sync.Mutex),
		inFlight:           make(map[string]chan struct{}),
		outbox:             make(map[string]protocol.DaemonResultMessage),
		pendingPersistence: make(map[string]protocol.DaemonResultMessage),
		desktopSnapshot:    make(map[string]protocol.DesktopObservation),
		managedCatalog:     make(map[string]protocol.Session),
		sendReadiness:      make(map[string]desktopReadinessRecord),
		desktopGeneration:  make(map[string]uint64),
		historyContexts:    newHistoryContexts(),
		historyRequests:    newHistoryRequests(),
		mediaState:         newMediaState(),
		terminalDiscovery:  make(chan struct{}, 1),
		terminalReadiness:  make(map[string]terminalReadinessRecord),
	}
	if cfg.DesktopSocketPath != "" {
		d.desktopObserver = codexdesktop.NewDesktopObserver(cfg.DesktopSocketPath)
		d.desktopController = codexdesktop.NewDesktopController(cfg.DesktopSocketPath)
		d.desktopHistory = codexdesktop.NewDesktopHistoryReader(cfg.DesktopSocketPath)
	}
	if cfg.CodexHome != "" {
		d.sessionCatalog = rollout.NewRolloutCatalog(cfg.CodexHome)
	}
	if cfg.TerminalSocketPath != "" && len(cfg.TerminalPanes) != 0 {
		observer := terminal.NewObserver(cfg.TerminalSocketPath, cfg.TerminalPanes)
		d.terminalObserver = observer
		if len(cfg.TerminalHistoryRoots) != 0 {
			if err := config.ValidateTerminalHistory(cfg.TerminalHistoryRoots, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
				log.Printf("terminal history disabled: invalid explicit configuration")
			} else {
				d.terminalHistory = terminal.NewHistoryReader(observer, transcript.New(transcript.Config{Roots: cfg.TerminalHistoryRoots}))
			}
		}
		if cfg.TerminalSendMode == protocol.TerminalNonAtomicMode {
			d.terminalController = terminal.NewDeliveryController(observer)
		}
	}
	return d
}
