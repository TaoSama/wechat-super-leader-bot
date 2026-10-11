package codex

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const desktopTestOwnerTimeout = 80 * time.Millisecond

func desktopObserverWithTimeout(path string, timeout time.Duration) *DesktopObserver {
	observer := NewDesktopObserver(path)
	observer.ownerTimeout = timeout
	return observer
}

func desktopDiscoveryRequests(c *desktopConn, count int) (map[string]desktopEnvelope, error) {
	requests := make(map[string]desktopEnvelope, count)
	for range count {
		request, err := c.read()
		if err != nil {
			return nil, err
		}
		var params struct {
			ConversationID string `json:"conversationId"`
			HostID         string `json:"hostId"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil {
			return nil, err
		}
		if request.Type != "request" || request.Method != desktopDiscoverOwner || request.Version != 1 || params.HostID != "local" || params.ConversationID == "" {
			return nil, fmt.Errorf("invalid pipelined discovery: %+v", request)
		}
		if _, duplicate := requests[params.ConversationID]; duplicate {
			return nil, fmt.Errorf("duplicate discovery for %s", params.ConversationID)
		}
		requests[params.ConversationID] = request
	}
	return requests, nil
}

func desktopAnySessionEnvelope(session, owner string, change map[string]any) (desktopEnvelope, error) {
	data, err := json.Marshal(map[string]any{"conversationId": session, "hostId": "local", "change": change})
	return desktopEnvelope{Type: "broadcast", Method: desktopStateChanged, Version: 11, SourceClientID: owner,
		TargetClientIDs: []string{"observer-client"}, Params: data}, err
}

func desktopAnySessionSnapshot(session, owner, status string) (desktopEnvelope, error) {
	return desktopAnySessionEnvelope(session, owner, map[string]any{"type": "snapshot", "revision": 1,
		"conversationState": map[string]any{"id": session, "hostId": "local", "threadRuntimeStatus": map[string]any{"type": status}}})
}

func desktopReadFollow(c *desktopConn, session, owner string, following bool) error {
	message, err := c.read()
	if err != nil {
		return err
	}
	var params struct {
		ConversationID string `json:"conversationId"`
		HostID         string `json:"hostId"`
		Following      bool   `json:"following"`
	}
	if err := json.Unmarshal(message.Params, &params); err != nil {
		return err
	}
	if message.Method != desktopFollowingChanged || message.SourceClientID != "observer-client" || len(message.TargetClientIDs) != 1 || message.TargetClientIDs[0] != owner || params.ConversationID != session || params.HostID != "local" || params.Following != following {
		return fmt.Errorf("wrong follow for %s: %+v", session, message)
	}
	return nil
}

func desktopReplyAndSnapshot(c *desktopConn, request desktopEnvelope, session, owner string) error {
	if err := desktopReply(c, request, owner, nil); err != nil {
		return err
	}
	if err := desktopReadFollow(c, session, owner, true); err != nil {
		return err
	}
	snapshot, err := desktopAnySessionSnapshot(session, owner, "active")
	if err != nil {
		return err
	}
	return c.write(snapshot)
}

func desktopOnlyUnsubscribeUntilClosed(c *desktopConn, valid map[string]string) error {
	for {
		message, err := c.read()
		if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
			return nil
		}
		if err != nil {
			return err
		}
		var params struct {
			ConversationID string `json:"conversationId"`
			Following      bool   `json:"following"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		owner, ok := valid[params.ConversationID]
		if !ok || params.Following || message.Method != desktopFollowingChanged || len(message.TargetClientIDs) != 1 || message.TargetClientIDs[0] != owner {
			return fmt.Errorf("late response subscribed wrong session: %+v", message)
		}
	}
}

func TestDesktopDiscoveryPipelineOutOfOrderAndTimeoutIsolation(t *testing.T) {
	expired := make(chan struct{})
	owners := map[string]string{"session-a": "owner-session-a", "session-b": "owner-session-b"}
	path := desktopWatchFixture(t, owners, func(c *desktopConn, id string) error {
		snapshot, err := desktopAnySessionSnapshot(id, owners[id], "active")
		if err != nil {
			return err
		}
		if err := c.write(snapshot); err != nil {
			return err
		}
		if id != "session-a" {
			return desktopOnlyUnsubscribeUntilClosed(c, owners)
		}
		select {
		case <-expired:
		case <-time.After(desktopTestTimeout):
			return errors.New("silent discovery did not expire")
		}
		patch, err := desktopAnySessionEnvelope("session-a", "owner-session-a", desktopPatchChange(1, 2,
			map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"}))
		if err != nil {
			return err
		}
		if err := c.write(patch); err != nil {
			return err
		}
		return desktopOnlyUnsubscribeUntilClosed(c, owners)
	}, func(c *desktopConn, first desktopEnvelope) error {
		requests, err := desktopDiscoveryWithFirst(c, first, 3)
		if err != nil {
			return err
		}
		// The silent request never responds; confirmed owners arrive out of order.
		for _, id := range []string{"session-b", "session-a"} {
			if err := desktopReply(c, requests[id], owners[id], nil); err != nil {
				return err
			}
		}
		return desktopExpectClosed(c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	observations := map[string][]protocol.DesktopObservation{}
	err := desktopObserverWithTimeout(path, desktopTestOwnerTimeout).Watch(ctx, []string{"silent", "session-a", "session-b"}, func(id string, o protocol.DesktopObservation) {
		observations[id] = append(observations[id], o)
		if id == "silent" {
			if len(observations["session-a"]) == 0 || len(observations["session-b"]) == 0 {
				t.Error("silent discovery delayed valid owner snapshots")
			}
			close(expired)
		}
		if id == "session-a" && o.Status == "idle" {
			cancel()
		}
	})
	available := desktopAvailableObservations(observations)
	if err == nil || len(observations["silent"]) != 1 || observations["silent"][0].Availability != "unavailable" || len(available["session-a"]) != 2 || available["session-a"][1].Status != "idle" || len(available["session-b"]) != 1 {
		t.Fatalf("pipeline observations = %+v, termination = %v", observations, err)
	}
}

func TestDesktopDiscoveryLateResponseCannotSubscribeExpiredTarget(t *testing.T) {
	expired := make(chan struct{})
	path := desktopWatchFixture(t, map[string]string{"session": "owner"}, func(c *desktopConn, _ string) error {
		snapshot, err := desktopAnySessionSnapshot("session", "owner", "active")
		if err != nil {
			return err
		}
		if err := c.write(snapshot); err != nil {
			return err
		}
		select {
		case <-expired:
		case <-time.After(desktopTestTimeout):
			return errors.New("silent discovery did not expire")
		}
		patch, err := desktopAnySessionEnvelope("session", "owner", desktopPatchChange(1, 2,
			map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"}))
		if err != nil {
			return err
		}
		if err := c.write(patch); err != nil {
			return err
		}
		return desktopOnlyUnsubscribeUntilClosed(c, map[string]string{"session": "owner"})
	}, func(c *desktopConn, first desktopEnvelope) error {
		requests, err := desktopDiscoveryWithFirst(c, first, 2)
		if err != nil {
			return err
		}
		if err := desktopReply(c, requests["session"], "owner", nil); err != nil {
			return err
		}
		// A reply after expiry cannot survive the closed discovery connection.
		timer := time.NewTimer(2 * desktopTestOwnerTimeout)
		defer timer.Stop()
		<-timer.C
		if err := desktopReply(c, requests["silent"], "late-owner", nil); err != nil {
			var networkError net.Error
			if !errors.As(err, &networkError) {
				return err
			}
		}
		return desktopExpectClosed(c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	observations := map[string][]protocol.DesktopObservation{}
	err := desktopObserverWithTimeout(path, desktopTestOwnerTimeout).Watch(ctx, []string{"silent", "session"}, func(id string, o protocol.DesktopObservation) {
		observations[id] = append(observations[id], o)
		if id == "silent" {
			close(expired)
		}
		if id == "session" && o.Status == "idle" {
			cancel()
		}
	})
	available := desktopAvailableObservations(observations)
	if err == nil || len(observations["silent"]) != 1 || observations["silent"][0].Availability != "unavailable" || len(available["session"]) != 2 || available["session"][1].Status != "idle" {
		t.Fatalf("late response changed subscription: observations = %+v, error = %v", observations, err)
	}
}

func desktopDiscoveryWithFirst(c *desktopConn, first desktopEnvelope, count int) (map[string]desktopEnvelope, error) {
	requests, err := desktopDiscoveryRequests(c, count-1)
	if err != nil {
		return nil, err
	}
	var params struct {
		ConversationID string `json:"conversationId"`
	}
	if err := json.Unmarshal(first.Params, &params); err != nil {
		return nil, err
	}
	requests[params.ConversationID] = first
	return requests, nil
}

func desktopAvailableObservations(observations map[string][]protocol.DesktopObservation) map[string][]protocol.DesktopObservation {
	available := make(map[string][]protocol.DesktopObservation)
	for id, results := range observations {
		for _, result := range results {
			if result.Availability == "available" {
				available[id] = append(available[id], result)
			}
		}
	}
	return available
}

func TestDesktopDiscoveryPartialFrameCancellationJoinsReader(t *testing.T) {
	for _, headerOnly := range []bool{true, false} {
		t.Run(fmt.Sprintf("partial header %v", headerOnly), func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := desktopHandshake(c); err != nil {
					return err
				}
				if _, err := desktopDiscoveryRequests(c, 1); err != nil {
					return err
				}
				const incompleteBodySize = 128
				var header [4]byte
				binary.LittleEndian.PutUint32(header[:], incompleteBodySize)
				partial := append(header[:], '{', '"')
				if headerOnly {
					partial = header[:2]
				}
				if _, err := c.Write(partial); err != nil {
					return err
				}
				return desktopExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			published := false
			started := time.Now()
			err := desktopObserverWithTimeout(path, time.Second).Snapshot(ctx, []string{"session"}, func(string, protocol.DesktopObservation) { published = true })
			if err == nil || published || time.Since(started) > desktopTestTimeout {
				t.Fatalf("partial frame did not stop reader: error = %v, published = %v, elapsed = %s", err, published, time.Since(started))
			}
		})
	}
}

func TestDesktopDiscoveryBoundedBatchDedupAndSnapshotCompletion(t *testing.T) {
	const batchLimit = 32
	ids := make([]string, batchLimit+1)
	for i := range ids {
		ids[i] = fmt.Sprintf("batch-session-%d", i)
	}
	ids = append(ids, ids[0])
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := desktopHandshake(c); err != nil {
			return err
		}
		requests, err := desktopDiscoveryRequests(c, batchLimit)
		if err != nil {
			return err
		}
		// No response has freed a slot: the 33rd request must still be queued.
		if err := c.SetReadDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
			return err
		}
		_, err = c.read()
		var timeout net.Error
		if !errors.As(err, &timeout) || !timeout.Timeout() {
			return fmt.Errorf("discovery exceeded %d pending requests: %v", batchLimit, err)
		}
		if err := c.SetReadDeadline(time.Now().Add(desktopTestTimeout)); err != nil {
			return err
		}
		first := requests[ids[0]]
		if err := c.write(desktopEnvelope{Type: "response", RequestID: first.RequestID, ResultType: "error"}); err != nil {
			return err
		}
		last, err := desktopDiscoveryRequests(c, 1)
		if err != nil {
			return err
		}
		if _, ok := last[ids[batchLimit]]; !ok {
			return fmt.Errorf("wrong queued session: %+v", last)
		}
		delete(requests, ids[0])
		requests[ids[batchLimit]] = last[ids[batchLimit]]
		for _, request := range requests {
			if err := c.write(desktopEnvelope{Type: "response", RequestID: request.RequestID, ResultType: "error"}); err != nil {
				return err
			}
		}
		return desktopExpectClosed(c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	observations := map[string]int{}
	err := desktopObserverWithTimeout(path, time.Second).Snapshot(ctx, ids, func(id string, o protocol.DesktopObservation) {
		observations[id]++
		if o.Availability != "unavailable" || o.Status != "unknown" {
			t.Errorf("wrong unavailable projection: %+v", o)
		}
	})
	if err != nil || len(observations) != batchLimit+1 {
		t.Fatalf("snapshot completed before all batches: observations = %+v, error = %v", observations, err)
	}
	for id, count := range observations {
		if count != 1 {
			t.Errorf("session %s published %d times", id, count)
		}
	}
}
