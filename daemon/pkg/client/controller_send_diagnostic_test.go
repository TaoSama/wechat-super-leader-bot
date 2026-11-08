package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type diagnosticWriter struct {
	fail       controllerSendStage
	err        error
	short      bool
	beforeNext func()
	deadlineAt int
	deadlines  int
}

func (w *diagnosticWriter) SetWriteDeadline(time.Time) error {
	w.deadlines++
	if w.fail == controllerSetDeadline && (w.deadlineAt == 0 || w.deadlines == w.deadlineAt) {
		return w.err
	}
	return nil
}
func (w *diagnosticWriter) NextWriter(int) (io.WriteCloser, error) {
	if w.beforeNext != nil {
		w.beforeNext()
	}
	if w.fail == controllerNextWriter {
		return nil, w.err
	}
	return w, nil
}
func (w *diagnosticWriter) Write(p []byte) (int, error) {
	if w.fail == controllerChunkWrite {
		return 1, w.err
	}
	if w.short {
		return len(p) - 1, nil
	}
	return len(p), nil
}
func (w *diagnosticWriter) Close() error {
	if w.fail == controllerWriterClose {
		return w.err
	}
	return nil
}
func (w *diagnosticWriter) WriteControl(int, []byte, time.Time) error {
	if w.fail == controllerTransferPing {
		return w.err
	}
	return nil
}

func TestControllerSendWriterStagesPreserveErrors(t *testing.T) {
	failure := errors.New("sensitive transport detail")
	for _, stage := range []controllerSendStage{controllerSetDeadline, controllerNextWriter, controllerChunkWrite, controllerTransferPing, controllerWriterClose} {
		t.Run(string(stage), func(t *testing.T) {
			writer := &diagnosticWriter{fail: stage, err: failure}
			metrics := controllerSendMetrics{}
			err := writeObservedControllerMessage(writer, []byte("payload"), time.Second, 0, &metrics)
			if !errors.Is(err, failure) || metrics.stage != stage {
				t.Fatalf("stage=%s error=%v", metrics.stage, err)
			}
			if stage == controllerChunkWrite && (metrics.chunkCount != 1 || metrics.processedBytes != 1) {
				t.Fatalf("partial writer acceptance lost: %+v", metrics)
			}
			if stage == controllerNextWriter || stage == controllerChunkWrite || stage == controllerWriterClose {
				if err != failure {
					t.Fatal("diagnostic changed error identity")
				}
			}
		})
	}
	for _, deadline := range []int{2, 3} {
		metrics := controllerSendMetrics{}
		err := writeObservedControllerMessage(&diagnosticWriter{fail: controllerSetDeadline, err: failure, deadlineAt: deadline}, []byte("payload"), time.Second, time.Second, &metrics)
		if !errors.Is(err, failure) || metrics.stage != controllerSetDeadline {
			t.Fatal("later deadline failure changed")
		}
	}
	metrics := controllerSendMetrics{}
	if err := writeObservedControllerMessage(&diagnosticWriter{short: true}, []byte("payload"), time.Second, time.Second, &metrics); err != io.ErrShortWrite {
		t.Fatalf("short-write identity changed: %v", err)
	}
}

func TestControllerSendFirstErrorEmitsOutsideLocks(t *testing.T) {
	failure := errors.New("first failure")
	d := newControllerSendDiagnostic("test-node")
	s := &controllerSender{conn: &diagnosticWriter{fail: controllerNextWriter, err: failure}, diagnostic: d}
	var records []controllerSendErrorRecord
	d.output = func(record controllerSendErrorRecord) {
		if !s.writeMu.TryLock() {
			t.Error("output held writeMu")
		} else {
			s.writeMu.Unlock()
		}
		if !d.mu.TryLock() {
			t.Error("output held diagnostic lock")
		} else {
			d.mu.Unlock()
		}
		records = append(records, record)
	}
	message := protocol.DaemonHeartbeatMessage{Type: "heartbeat"}
	for range 2 {
		if err := s.send(message); err != failure {
			t.Fatalf("send changed returned error: %v", err)
		}
	}
	d.setPhase(controllerCleanup)
	d.setPhase(controllerAfterCleanup)
	if err := s.send(message); err != failure {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].MessageKind != "heartbeat" || records[0].ConnectionPhase != controllerActive || records[0].Stage != controllerNextWriter {
		t.Fatalf("first snapshot replaced/repeated: %+v", records)
	}
	observed, err := time.Parse(time.RFC3339Nano, records[0].ObservedAtUTC)
	if err != nil {
		t.Fatal(err)
	}
	emitted, err := time.Parse(time.RFC3339Nano, records[0].EmittedAtUTC)
	if err != nil || emitted.Before(observed) {
		t.Fatalf("output time invalid: %v", err)
	}
}

func TestControllerSendEncodingFailureDoesNotWaitForWriteLock(t *testing.T) {
	d := newControllerSendDiagnostic("test-node")
	s := &controllerSender{diagnostic: d}
	records := make(chan controllerSendErrorRecord, 1)
	d.output = func(record controllerSendErrorRecord) { records <- record }
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	done := make(chan error, 1)
	go func() { done <- s.send(make(chan int)) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("encoding error swallowed")
		}
	case <-time.After(time.Second):
		t.Fatal("encoding failure waited on writeMu")
	}
	record := <-records
	if record.Stage != controllerEncode || record.ErrorClass != "encoding" || record.WriteMuWaitMs != 0 || record.HelperMs != 0 {
		t.Fatalf("encoding diagnostic: %+v", record)
	}
}

func TestControllerSendPayloadLimitPreservesSentinel(t *testing.T) {
	d := newControllerSendDiagnostic("test-node")
	var record controllerSendErrorRecord
	d.output = func(r controllerSendErrorRecord) { record = r }
	s := &controllerSender{diagnostic: d}
	err := s.send(protocol.DaemonResultMessage{Type: "result", Output: string([]byte{0xff})})
	if err != errControllerPayloadLimit || record.ErrorClass != "payload_limit" || record.Stage != controllerEncode {
		t.Fatalf("payload rejection changed: %v %+v", err, record)
	}
}

func TestControllerSendConcurrentFirstErrorAndLateAttemptIsolation(t *testing.T) {
	failure := errors.New("failure")
	d := newControllerSendDiagnostic("test-node")
	s := &controllerSender{conn: &diagnosticWriter{fail: controllerNextWriter, err: failure}, diagnostic: d}
	var emitted atomic.Int32
	d.output = func(controllerSendErrorRecord) { emitted.Add(1) }
	var sends sync.WaitGroup
	for range 32 {
		sends.Go(func() {
			if err := s.send(protocol.DaemonHeartbeatMessage{Type: "heartbeat"}); err != failure {
				t.Errorf("error changed: %v", err)
			}
		})
	}
	sends.Wait()
	if emitted.Load() != 1 {
		t.Fatalf("concurrent emissions=%d", emitted.Load())
	}

	old := newControllerSendDiagnostic("test-node")
	old.setPhase(controllerCleanup)
	old.setPhase(controllerAfterCleanup)
	newAttempt := newControllerSendDiagnostic("test-node")
	var late controllerSendErrorRecord
	lateCalls := 0
	old.output = func(record controllerSendErrorRecord) { late = record; lateCalls++ }
	lateSender := &controllerSender{conn: &diagnosticWriter{fail: controllerNextWriter, err: failure}, diagnostic: old}
	for range 2 {
		if err := lateSender.send(protocol.DaemonResultMessage{Type: "result"}); err != failure {
			t.Fatal(err)
		}
	}
	if lateCalls != 1 || late.ConnectionPhase != controllerAfterCleanup || late.AttemptSequence != old.attempt || late.AttemptSequence == newAttempt.attempt || newAttempt.reported {
		t.Fatalf("late result contaminated new attempt: %+v", late)
	}
}

func TestControllerSendFirstErrorDuringCleanup(t *testing.T) {
	d := newControllerSendDiagnostic("test-node")
	d.setPhase(controllerCleanup)
	var record controllerSendErrorRecord
	d.output = func(r controllerSendErrorRecord) { record = r }
	s := &controllerSender{conn: &diagnosticWriter{fail: controllerNextWriter, err: io.EOF}, diagnostic: d}
	if err := s.send(protocol.DaemonHeartbeatMessage{Type: "heartbeat"}); err != io.EOF || record.ConnectionPhase != controllerCleanup {
		t.Fatalf("cleanup observation lost: %v %+v", err, record)
	}
}

type diagnosticTimedMessage struct{ encoded chan struct{} }

func (m diagnosticTimedMessage) MarshalJSON() ([]byte, error) {
	time.Sleep(15 * time.Millisecond)
	close(m.encoded)
	return []byte(`{"type":"unknown"}`), nil
}

func TestControllerSendSeparatesEncodingQueueAndHelperTimes(t *testing.T) {
	d := newControllerSendDiagnostic("test-node")
	records := make(chan controllerSendErrorRecord, 1)
	d.output = func(record controllerSendErrorRecord) { records <- record }
	s := &controllerSender{conn: &diagnosticWriter{fail: controllerNextWriter, err: io.EOF,
		beforeNext: func() { time.Sleep(15 * time.Millisecond) }}, diagnostic: d}
	s.writeMu.Lock()
	encoded := make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- s.send(diagnosticTimedMessage{encoded: encoded}) }()
	<-encoded
	time.Sleep(15 * time.Millisecond)
	s.writeMu.Unlock()
	if err := <-done; err != io.EOF {
		t.Fatal(err)
	}
	record := <-records
	if record.EncodeMs < 10 || record.WriteMuWaitMs < 10 || record.HelperMs < 10 || record.AttemptElapsedMs < record.HelperMs {
		t.Fatalf("phase timings lost: %+v", record)
	}
}

func captureDiagnosticLogs(t *testing.T, writer io.Writer) {
	t.Helper()
	previous, flags := log.Writer(), log.Flags()
	log.SetOutput(writer)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(previous); log.SetFlags(flags) })
}

func TestControllerSendLogIsBoundedAndRedactedAndSuccessIsSilent(t *testing.T) {
	var output bytes.Buffer
	captureDiagnosticLogs(t, &output)
	secret := "secret-payload-address-token"
	for _, nodeID := range []string{strings.Repeat(secret, 1000), "node\n" + secret, "normal-node"} {
		d := newControllerSendDiagnostic(nodeID)
		s := &controllerSender{conn: &diagnosticWriter{}, diagnostic: d}
		message := protocol.DaemonResultMessage{Type: secret, Output: secret, CommandID: secret}
		if err := s.send(message); err != nil || output.Len() != 0 {
			t.Fatalf("success logged or failed: %v", err)
		}
		s.conn = &diagnosticWriter{fail: controllerNextWriter, err: errors.New(secret)}
		if err := s.send(message); err == nil {
			t.Fatal("failure swallowed")
		}
		line := bytes.TrimSpace(output.Bytes())
		if len(line) > controllerDiagnosticMaxBytes || !json.Valid(line) || bytes.Contains(line, []byte(secret)) || bytes.Count(line, []byte("\n")) != 0 {
			t.Fatalf("unbounded or sensitive log: %s", line)
		}
		output.Reset()
	}
}

func TestControllerSendCachedWebSocketWriteErrorIsAnObservation(t *testing.T) {
	conn, _ := controllerPipePair(t)
	first := writeControllerMessage(conn, []byte(strings.Repeat("x", 32*1024)), 100*time.Millisecond, time.Second)
	if first == nil {
		t.Fatal("fixture did not cache a write failure")
	}
	d := newControllerSendDiagnostic("isolated-pipe")
	var record controllerSendErrorRecord
	d.output = func(r controllerSendErrorRecord) { record = r }
	s := &controllerSender{conn: conn, diagnostic: d}
	if err := s.send(protocol.DaemonHeartbeatMessage{Type: "heartbeat"}); err != first {
		t.Fatalf("cached error identity changed: first=%v next=%v", first, err)
	}
	if record.Stage != controllerNextWriter || !record.Timeout || record.ErrorClass != "timeout" || record.ProcessedBytes != 0 {
		t.Fatalf("cached writeErr misattributed: %+v", record)
	}
}
