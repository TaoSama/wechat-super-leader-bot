package client

import (
	"context"
	"errors"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const ProbeTimeout = 20 * time.Second
const probeControlTimeout = 3 * time.Second

type SessionProbe struct {
	Sessions []protocol.Session `json:"sessions"`
	Sources  ProbeSources       `json:"sources"`
	Warnings []string           `json:"warnings"`
}

type ProbeSources struct {
	Control bool `json:"control"`
	Catalog bool `json:"catalog"`
	Desktop bool `json:"desktop"`
}

type discoveryResult struct {
	sessions []protocol.Session
	err      error
}

// Probe does not open the command journal, connect to Controller or start any
// native backend. Partial availability is reported explicitly, not as control.
func (d *Daemon) Probe(ctx context.Context) (SessionProbe, error) {
	result := SessionProbe{Sessions: []protocol.Session{}, Warnings: []string{}}
	controlResult := make(chan discoveryResult, 1)
	go func() {
		controlCtx, cancel := context.WithTimeout(ctx, probeControlTimeout)
		defer cancel()
		sessions, err := d.adapter.DiscoverSessions(controlCtx)
		if controlCtx.Err() != nil {
			err = controlCtx.Err()
		}
		controlResult <- discoveryResult{sessions, err}
	}()
	var catalog []protocol.Session
	if d.sessionCatalog != nil {
		catalogCtx, cancel := context.WithTimeout(ctx, catalogReadTimeout)
		var err error
		catalog, err = d.sessionCatalog.DiscoverSessions(catalogCtx)
		result.Sources.Catalog = err == nil && catalogCtx.Err() == nil
		cancel()
		if !result.Sources.Catalog {
			catalog = nil
			result.Warnings = append(result.Warnings, "Session file discovery unavailable or incomplete")
		}
	}
	control := <-controlResult
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	result.Sources.Control = control.err == nil
	if !result.Sources.Control {
		control.sessions = nil
		result.Warnings = append(result.Warnings, "Shared control unavailable; file discovery does not grant send capability")
	}
	if !result.Sources.Control && !result.Sources.Catalog {
		return result, errors.New("no session discovery source available")
	}
	result.Sessions = mergeSessionSources(control.sessions, catalog)
	if d.desktopObserver == nil || len(result.Sessions) == 0 {
		return result, nil
	}
	ids := make([]string, 0, len(result.Sessions))
	positions := make(map[string]int, len(result.Sessions))
	for i, session := range result.Sessions {
		ids = append(ids, session.ID)
		positions[session.ID] = i
	}
	observer, ok := d.desktopObserver.(interface {
		Snapshot(context.Context, []string, func(string, protocol.DesktopObservation)) error
	})
	if !ok {
		return result, errors.New("desktop observer does not support snapshots")
	}
	err := observer.Snapshot(ctx, ids, func(id string, observation protocol.DesktopObservation) {
		if index, exists := positions[id]; exists {
			result.Sessions[index].DesktopObservation = &observation
		}
	})
	result.Sources.Desktop = err == nil
	if err != nil {
		result.Warnings = append(result.Warnings, "Desktop observation incomplete; unavailable owners remain unknown")
	}
	return result, nil
}
