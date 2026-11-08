package client

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

type controllerSendStage string
type controllerConnectionPhase string

const (
	controllerEncode       controllerSendStage = "encode"
	controllerSetDeadline  controllerSendStage = "set_write_deadline"
	controllerNextWriter   controllerSendStage = "next_writer"
	controllerChunkWrite   controllerSendStage = "chunk_write"
	controllerTransferPing controllerSendStage = "transfer_ping"
	controllerWriterClose  controllerSendStage = "writer_close"

	controllerActive       controllerConnectionPhase = "active"
	controllerCleanup      controllerConnectionPhase = "cleanup"
	controllerAfterCleanup controllerConnectionPhase = "after_cleanup"

	controllerDiagnosticNodeBytes = 64
	controllerDiagnosticMaxBytes  = 2048
)

var (
	controllerProcessInstance = strconv.Itoa(os.Getpid()) + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	controllerAttemptSequence atomic.Uint64
)

type controllerSendMetrics struct {
	stage          controllerSendStage
	messageKind    string
	encodeTime     time.Duration
	writeMuWait    time.Duration
	helperTime     time.Duration
	encodedBytes   int
	processedBytes int
	chunkCount     int
}

type controllerSendErrorRecord struct {
	SchemaVersion     int                       `json:"schemaVersion"`
	Event             string                    `json:"event"`
	NodeID            string                    `json:"nodeId"`
	ProcessInstanceID string                    `json:"processInstanceId"`
	AttemptSequence   uint64                    `json:"attemptSequence"`
	ConnectionPhase   controllerConnectionPhase `json:"connectionPhase"`
	ObservedAtUTC     string                    `json:"observedAtUTC"`
	EmittedAtUTC      string                    `json:"emittedAtUTC"`
	AttemptElapsedMs  int64                     `json:"attemptElapsedMs"`
	MessageKind       string                    `json:"messageKind"`
	Stage             controllerSendStage       `json:"stage"`
	EncodeMs          int64                     `json:"encodeMs"`
	WriteMuWaitMs     int64                     `json:"writeMuWaitMs"`
	HelperMs          int64                     `json:"helperMs"`
	EncodedBytes      int                       `json:"encodedBytes"`
	ProcessedBytes    int                       `json:"processedBytes"`
	ChunkCount        int                       `json:"chunkCount"`
	ErrorClass        string                    `json:"errorClass"`
	Timeout           bool                      `json:"timeout"`
}

type controllerSendDiagnostic struct {
	mu       sync.Mutex
	reported bool
	phase    controllerConnectionPhase
	started  time.Time
	nodeID   string
	attempt  uint64
	output   func(controllerSendErrorRecord)
}

func newControllerSendDiagnostic(nodeID string) *controllerSendDiagnostic {
	if len(nodeID) > controllerDiagnosticNodeBytes || nodeID == "" {
		nodeID = "unknown"
	}
	for _, c := range nodeID {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			nodeID = "unknown"
			break
		}
	}
	return &controllerSendDiagnostic{phase: controllerActive, started: time.Now(), nodeID: nodeID,
		attempt: controllerAttemptSequence.Add(1), output: logControllerSendError}
}

func (d *controllerSendDiagnostic) setPhase(phase controllerConnectionPhase) {
	d.mu.Lock()
	d.phase = phase
	d.mu.Unlock()
}

// capture owns the single output claim, but never performs I/O. A cached Gorilla
// writeErr may predate this application observation, including an automatic pong.
func (d *controllerSendDiagnostic) capture(metrics controllerSendMetrics, err error) *controllerSendErrorRecord {
	if err == nil {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.reported {
		return nil
	}
	d.reported = true
	now := time.Now()
	class, timeout := controllerSendErrorClass(err, metrics.stage)
	return &controllerSendErrorRecord{SchemaVersion: 1, Event: "controller_application_send_error",
		NodeID: d.nodeID, ProcessInstanceID: controllerProcessInstance, AttemptSequence: d.attempt,
		ConnectionPhase: d.phase, ObservedAtUTC: now.UTC().Format(time.RFC3339Nano),
		AttemptElapsedMs: now.Sub(d.started).Milliseconds(), MessageKind: metrics.messageKind, Stage: metrics.stage,
		EncodeMs: metrics.encodeTime.Milliseconds(), WriteMuWaitMs: metrics.writeMuWait.Milliseconds(), HelperMs: metrics.helperTime.Milliseconds(),
		EncodedBytes: metrics.encodedBytes, ProcessedBytes: metrics.processedBytes, ChunkCount: metrics.chunkCount,
		ErrorClass: class, Timeout: timeout}
}

func (d *controllerSendDiagnostic) emit(record *controllerSendErrorRecord) {
	if record != nil {
		record.EmittedAtUTC = time.Now().UTC().Format(time.RFC3339Nano)
		d.output(*record)
	}
}

func logControllerSendError(record controllerSendErrorRecord) {
	encoded, err := json.Marshal(record)
	if err != nil || len(encoded) > controllerDiagnosticMaxBytes {
		log.Print(`{"schemaVersion":1,"event":"controller_send_diagnostic_unavailable"}`)
		return
	}
	log.Print(string(encoded))
}

func controllerSendErrorClass(err error, stage controllerSendStage) (string, bool) {
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return "timeout", true
	}
	switch {
	case errors.Is(err, errControllerPayloadLimit):
		return "payload_limit", false
	case errors.Is(err, net.ErrClosed):
		return "closed", false
	case errors.Is(err, io.ErrShortWrite):
		return "short_write", false
	case errors.Is(err, websocket.ErrCloseSent):
		return "close_sent", false
	case stage == controllerEncode:
		return "encoding", false
	default:
		return "write", false
	}
}

func controllerMessageKind(msg any) string {
	switch msg.(type) {
	case protocol.DaemonHelloMessage, *protocol.DaemonHelloMessage:
		return "hello"
	case protocol.DaemonHeartbeatMessage, *protocol.DaemonHeartbeatMessage:
		return "heartbeat"
	case protocol.DaemonResultMessage, *protocol.DaemonResultMessage:
		return "result"
	case protocol.DaemonHistoryMessage, *protocol.DaemonHistoryMessage:
		return "history"
	case protocol.DaemonMediaListMessage, *protocol.DaemonMediaListMessage:
		return "media_list"
	case protocol.DaemonMediaChunkMessage, *protocol.DaemonMediaChunkMessage:
		return "media_chunk"
	case automationResponse, *automationResponse:
		return "automation_response"
	default:
		return "unknown"
	}
}

type controllerSender struct {
	conn       controllerMessageWriter
	writeMu    sync.Mutex
	diagnostic *controllerSendDiagnostic
}

func (s *controllerSender) send(msg any) error {
	metrics := controllerSendMetrics{stage: controllerEncode, messageKind: controllerMessageKind(msg)}
	started := time.Now()
	encoded, err := encodeControllerMessage(msg)
	metrics.encodeTime, metrics.encodedBytes = time.Since(started), len(encoded)
	if err != nil {
		s.diagnostic.emit(s.diagnostic.capture(metrics, err))
		return err
	}
	waiting := time.Now()
	s.writeMu.Lock()
	var record *controllerSendErrorRecord
	defer func() {
		s.writeMu.Unlock()
		s.diagnostic.emit(record)
	}()
	metrics.writeMuWait = time.Since(waiting)
	started = time.Now()
	err = writeObservedControllerMessage(s.conn, encoded, controllerWriteTimeout, regularHeartbeatInterval, &metrics)
	metrics.helperTime = time.Since(started)
	record = s.diagnostic.capture(metrics, err)
	return err
}
