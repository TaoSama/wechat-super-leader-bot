package client

import (
	"context"
	"sync"
)

// Every source refreshes independently after the cached hello and receipt replay.
// Discovery never gates connection liveness or another source's refresh.
func (d *Daemon) startSessionWorkers(ctx context.Context, updates chan<- struct{}) func() {
	var workers sync.WaitGroup
	for _, refresh := range []func(context.Context, chan<- struct{}){
		d.refreshSessions, d.refreshSessionCatalog, d.refreshCatalogRecovery, d.refreshDesktop, d.refreshSendReadiness, d.refreshTerminal, d.refreshTerminalReadiness,
	} {
		workers.Add(1)
		go func() { defer workers.Done(); refresh(ctx, updates) }()
	}
	return workers.Wait
}
