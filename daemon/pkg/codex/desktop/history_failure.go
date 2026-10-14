package desktop

import (
	"errors"
	"fmt"
	"log"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type historyFailureReason string

const (
	historyFailureUnknown      historyFailureReason = "invalid-state"
	historyFailureInitialize   historyFailureReason = "initialize"
	historyFailureTransport    historyFailureReason = "transport"
	historyFailureFrameLimit   historyFailureReason = "frame-limit"
	historyFailureRequestWrite historyFailureReason = "request-write"
	historyFailureDeadline     historyFailureReason = "request-deadline"
	historyFailureIdle         historyFailureReason = "idle-eviction"
	historyFailureStopped      historyFailureReason = "reader-stopped"
	historyFailureResponse     historyFailureReason = "response-binding"
	historyFailureOwner        historyFailureReason = "owner-mismatch"
	historyFailureVersion      historyFailureReason = "version-mismatch"
	historyFailureFollowing    historyFailureReason = "following-revoked"
	historyFailureNoise        historyFailureReason = "noise-limit"
	historyFailureRevision     historyFailureReason = "revision-regressed"
	historyFailureSnapshot     historyFailureReason = "same-revision-changed"
	historyFailurePatch        historyFailureReason = "patch-gap"
	historyFailureGeneration   historyFailureReason = "generation-changed"
	historyFailurePrefix       historyFailureReason = "history-prefix-changed"
)

type desktopHistoryFailure struct {
	message string
	reason  historyFailureReason
}

func (failure *desktopHistoryFailure) Error() string { return failure.message }

// Keep the public error contract unchanged; the reason never includes wire data.
func historyFailure(message string, reason historyFailureReason) error {
	return &desktopHistoryFailure{message: message, reason: reason}
}

func safeHistoryFailureReason(reason historyFailureReason) historyFailureReason {
	switch reason {
	case historyFailureInitialize, historyFailureTransport, historyFailureFrameLimit,
		historyFailureRequestWrite, historyFailureDeadline, historyFailureIdle, historyFailureStopped,
		historyFailureResponse, historyFailureOwner, historyFailureVersion, historyFailureFollowing,
		historyFailureNoise, historyFailureRevision, historyFailureSnapshot, historyFailurePatch,
		historyFailureGeneration, historyFailurePrefix:
		return reason
	default:
		return historyFailureUnknown
	}
}

func historyFailureReasonOf(err error) historyFailureReason {
	var failure *desktopHistoryFailure
	if errors.As(err, &failure) {
		return safeHistoryFailureReason(failure.reason)
	}
	return historyFailureUnknown
}

// Only fixed reason codes and lifecycle booleans are logged. Never log an error,
// transcript, target/owner identity, socket, generation, context or cursor.
func (entry *desktopHistoryEntry) logFailureLocked(reason historyFailureReason) {
	log.Print(historyFailureLogLine(reason, entry.delivered, entry.active > 0, entry.ready, entry.loadRequested))
}

func historyFailureLogLine(reason historyFailureReason, delivered, active, ready, loadRequested bool) string {
	return fmt.Sprintf("desktop history reader ended: reason=%s delivered=%t active=%t ready=%t load_requested=%t",
		safeHistoryFailureReason(reason), delivered, active, ready, loadRequested)
}

type desktopHistoryNoise struct {
	clientStatus, discoveryRequest, state, following, response, other int
}

func (noise *desktopHistoryNoise) observe(message desktopEnvelope) {
	switch {
	case message.Type == "broadcast" && message.Method == "client-status-changed":
		noise.clientStatus++
	case message.Type == "client-discovery-request":
		noise.discoveryRequest++
	case message.Type == "broadcast" && message.Method == desktopStateChanged:
		noise.state++
	case message.Type == "broadcast" && message.Method == desktopFollowingChanged:
		noise.following++
	case message.Type == "response":
		noise.response++
	default:
		noise.other++
	}
}

func (noise desktopHistoryNoise) logLine(pending, subscribed bool) string {
	return fmt.Sprintf("desktop history noise limit: client_status=%d discovery_request=%d state=%d following=%d response=%d other=%d request_pending=%t subscribed=%t",
		noise.clientStatus, noise.discoveryRequest, noise.state, noise.following, noise.response, noise.other, pending, subscribed)
}

func (entry *desktopHistoryEntry) failReason(message string, reason historyFailureReason) {
	entry.mu.Lock()
	defer entry.mu.Unlock()
	entry.logFailureLocked(reason)
	if entry.delivered {
		message = protocol.HistoryContextExpired
	}
	entry.err = historyError(message)
	entry.notifyLocked()
}
