package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type desktopHistoryStream struct {
	entry                    *desktopHistoryEntry
	connection               *desktopConn
	owner, requestID, method string
	deadline                 time.Time
	noise                    int
	noiseKinds               desktopHistoryNoise
	operationTimeout         time.Duration
	subscribed               bool
}

func (r *DesktopHistoryReader) run(entry *desktopHistoryEntry) {
	defer close(entry.done)
	defer func() {
		entry.mu.Lock()
		if entry.err == nil {
			entry.logFailureLocked(historyFailureStopped)
			entry.err = historyError(protocol.HistoryContextExpired)
		}
		entry.raw = nil
		entry.view = desktopHistoryView{}
		entry.order = nil
		entry.cursors = nil
		entry.anchorTokens = nil
		entry.notifyLocked()
		entry.mu.Unlock()
	}()
	connection, cleanup, err := connectDesktopClient(entry.ctx, r.socketPath, desktopHistoryClient)
	if err != nil {
		entry.failReason(protocol.HistoryUnavailable, historyFailureInitialize)
		return
	}
	if err := connection.SetReadDeadline(time.Time{}); err != nil {
		cleanup()
		entry.failReason(protocol.HistoryFailed, historyFailureTransport)
		return
	}
	events, readerDone := make(chan desktopReadResult, 1), make(chan struct{})
	readCtx, readCancel := context.WithCancel(entry.ctx)
	go readDesktopHistoryEvents(readCtx, connection, events, readerDone)
	stream := desktopHistoryStream{entry: entry, connection: connection, operationTimeout: r.operationTimeout}
	defer func() {
		if stream.owner != "" {
			if err := connection.SetWriteDeadline(time.Now().Add(desktopUnsubscribeTimeout)); err != nil {
				if entry.ctx.Err() == nil {
					log.Printf("desktop history unsubscribe deadline failed")
				}
			} else if err := connection.follow(stream.owner, entry.sessionID, false); err != nil && entry.ctx.Err() == nil {
				log.Printf("desktop history unsubscribe failed")
			}
		}
		readCancel()
		cleanup()
		<-readerDone
	}()
	if err := stream.request(desktopDiscoverOwner, 1, ""); err != nil {
		entry.failReason(protocol.HistoryUnavailable, historyFailureRequestWrite)
		return
	}
	tickDuration := min(desktopDiscoveryTick, r.idleTTL)
	if tickDuration <= 0 {
		tickDuration = desktopDiscoveryTick
	}
	ticker := time.NewTicker(tickDuration)
	defer ticker.Stop()
	for {
		select {
		case <-entry.ctx.Done():
			return
		case <-ticker.C:
			entry.mu.Lock()
			idle := entry.active == 0 && time.Since(entry.lastUsed) >= r.idleTTL
			entry.mu.Unlock()
			if idle {
				entry.failReason(protocol.HistoryContextExpired, historyFailureIdle)
				return
			}
			if !stream.deadline.IsZero() && !time.Now().Before(stream.deadline) {
				entry.failReason(protocol.HistoryTimeout, historyFailureDeadline)
				return
			}
		case <-entry.wake:
			if err := stream.maybeLoad(); err != nil {
				entry.failReason(err.Error(), historyFailureRequestWrite)
				return
			}
		case event := <-events:
			if event.err != nil {
				if errors.Is(event.err, errDesktopFrameTooLarge) {
					entry.failReason(protocol.HistoryTooLarge, historyFailureFrameLimit)
				} else {
					entry.failReason(protocol.HistoryUnavailable, historyFailureTransport)
				}
				return
			}
			if err := stream.handle(event.message); err != nil {
				entry.failReason(err.Error(), historyFailureReasonOf(err))
				return
			}
			if err := stream.maybeLoad(); err != nil {
				entry.failReason(err.Error(), historyFailureRequestWrite)
				return
			}
		}
	}
}

func readDesktopHistoryEvents(ctx context.Context, c *desktopConn, events chan<- desktopReadResult, done chan<- struct{}) {
	defer close(done)
	for {
		message, err := c.readWithLimit(desktopHistoryRawLimit)
		select {
		case events <- desktopReadResult{message: message, err: err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}

func (stream *desktopHistoryStream) request(method string, version int, target string) error {
	id, err := protocol.NewDispatchID()
	if err != nil {
		return historyError(protocol.HistoryFailed)
	}
	params := map[string]any{"conversationId": stream.entry.sessionID}
	if method == desktopDiscoverOwner {
		params["hostId"] = "local"
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return historyError(protocol.HistoryFailed)
	}
	if err := stream.connection.SetWriteDeadline(time.Now().Add(desktopRequestTimeout)); err != nil {
		return historyError(protocol.HistoryUnavailable)
	}
	if err := stream.connection.write(desktopEnvelope{Type: "request", RequestID: id, SourceClientID: stream.connection.clientID, TargetClientID: target,
		Method: method, Version: version, Params: encoded, TimeoutMS: int(stream.operationTimeout.Milliseconds())}); err != nil {
		return historyError(protocol.HistoryUnavailable)
	}
	stream.requestID, stream.method, stream.deadline = id, method, time.Now().Add(stream.operationTimeout)
	return nil
}

func (stream *desktopHistoryStream) maybeLoad() error {
	entry := stream.entry
	entry.mu.Lock()
	load := entry.ready && !entry.view.complete && !entry.loadRequested && entry.active > 0 && stream.requestID == ""
	if load {
		entry.loadRequested = true
		entry.notifyLocked()
	}
	entry.mu.Unlock()
	if load {
		return stream.request(desktopLoadCompleteHistory, 1, stream.owner)
	}
	return nil
}

func (stream *desktopHistoryStream) handle(message desktopEnvelope) error {
	if handled, err := stream.routerControl(message); handled {
		return err
	}
	if message.Type == "response" && message.RequestID == stream.requestID && stream.requestID != "" {
		// Responses carry no method version. The exact version is established by
		// the request; response binding is request ID, method and owner identity.
		if message.Method != stream.method || !time.Now().Before(stream.deadline) {
			return historyFailure(protocol.HistoryFailed, historyFailureResponse)
		}
		if message.ResultType != "success" {
			return historyFailure(protocol.HistoryUnavailable, historyFailureResponse)
		}
		if stream.owner != "" && message.HandledByClientID != stream.owner {
			return historyFailure(protocol.HistoryContextExpired, historyFailureOwner)
		}
		stream.resetNoise()
		method := stream.method
		stream.requestID, stream.method = "", ""
		switch method {
		case desktopDiscoverOwner:
			if !protocol.ValidHistoryIdentity(message.HandledByClientID) || !protocol.ValidTurnID(message.HandledByClientID) || message.HandledByClientID == stream.connection.clientID {
				return historyFailure(protocol.HistoryUnavailable, historyFailureOwner)
			}
			stream.owner = message.HandledByClientID
			return stream.request(desktopReadSettings, 1, stream.owner)
		case desktopReadSettings:
			var result map[string]any
			if json.Unmarshal(message.Result, &result) != nil {
				return historyError(protocol.HistoryFailed)
			}
			settings, err := historyObject(result["settings"])
			if err != nil || !historyOrdinary(settings) {
				return historyError(protocol.HistoryUnavailable)
			}
			if err := stream.connection.SetWriteDeadline(time.Now().Add(desktopRequestTimeout)); err != nil {
				return historyError(protocol.HistoryUnavailable)
			}
			if err := stream.connection.follow(stream.owner, stream.entry.sessionID, true); err != nil {
				return historyError(protocol.HistoryUnavailable)
			}
			stream.subscribed = true
			stream.deadline = time.Now().Add(stream.operationTimeout)
		case desktopLoadCompleteHistory:
			var result map[string]any
			if json.Unmarshal(message.Result, &result) != nil {
				return historyError(protocol.HistoryFailed)
			}
			revision, ok := historyRevision(result["revision"])
			if !ok {
				return historyError(protocol.HistoryFailed)
			}
			stream.entry.mu.Lock()
			stream.entry.loadResponded, stream.entry.loadRevision = true, revision
			stream.entry.notifyLocked()
			caughtUp := stream.entry.ready && stream.entry.revision >= revision
			stream.entry.mu.Unlock()
			if caughtUp {
				stream.deadline = time.Time{}
			} else {
				stream.deadline = time.Now().Add(stream.operationTimeout)
			}
		default:
			return historyError(protocol.HistoryFailed)
		}
		return nil
	}
	if message.Type == "broadcast" && (message.Method == desktopStateChanged || message.Method == desktopFollowingChanged) {
		targeted := false
		for _, target := range message.TargetClientIDs {
			targeted = targeted || target == stream.connection.clientID
		}
		if !targeted {
			return stream.skip(message)
		}
		// Before following, broadcasts cannot establish or invalidate this
		// subscription. Count them as noise without extending the handshake.
		if !stream.subscribed {
			return stream.skip(message)
		}
		if message.SourceClientID != stream.owner || stream.owner == "" {
			return historyFailure(protocol.HistoryContextExpired, historyFailureOwner)
		}
		if message.Method == desktopFollowingChanged {
			return stream.following(message)
		}
		if message.Version != 11 {
			return historyFailure(protocol.HistoryFailed, historyFailureVersion)
		}
		if err := stream.entry.change(message.Params); err != nil {
			return err
		}
		stream.resetNoise()
		stream.entry.mu.Lock()
		ready := !stream.entry.loadRequested || (stream.entry.loadResponded && stream.entry.revision >= stream.entry.loadRevision)
		stream.entry.mu.Unlock()
		if ready && stream.requestID == "" {
			stream.deadline = time.Time{}
		}
		return nil
	}
	return stream.skip(message)
}

func (stream *desktopHistoryStream) following(message desktopEnvelope) error {
	var params map[string]any
	if message.Version != 1 || json.Unmarshal(message.Params, &params) != nil || params["conversationId"] != stream.entry.sessionID || params["hostId"] != "local" {
		return historyError(protocol.HistoryFailed)
	}
	following, ok := params["following"].(bool)
	if !ok {
		return historyError(protocol.HistoryFailed)
	}
	if !following {
		return historyFailure(protocol.HistoryContextExpired, historyFailureFollowing)
	}
	stream.resetNoise()
	return nil
}

func (stream *desktopHistoryStream) resetNoise() {
	stream.noise = 0
	stream.noiseKinds = desktopHistoryNoise{}
}

func (stream *desktopHistoryStream) skip(message desktopEnvelope) error {
	stream.noise++
	stream.noiseKinds.observe(message)
	if stream.noise > desktopSkipLimit {
		log.Print(stream.noiseKinds.logLine(stream.requestID != "", stream.subscribed))
		return historyFailure(protocol.HistoryFailed, historyFailureNoise)
	}
	return nil
}

func historyRevision(raw any) (uint64, bool) {
	number, ok := raw.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > maxDesktopRevision || math.Trunc(number) != number {
		return 0, false
	}
	return uint64(number), true
}
