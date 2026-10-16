package client

import (
	"context"
	"errors"
	"testing"
	"time"

	codexdesktop "github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/desktop"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestReadinessFreshIdleProofSchedulesBoundedRecovery(t *testing.T) {
	for _, change := range []string{"revision", "owner", "disconnect", "busy", "unknown"} {
		t.Run(change, func(t *testing.T) {
			d := newReadinessFixture(t)
			updates := make(chan struct{}, 1)
			now, id := time.Now(), "fixture-session"
			observation := idleReadinessObservation(now, 1)
			d.publishDesktop(id, observation, updates)
			generation := d.desktopGeneration[id]
			d.completeReadiness(readinessResult{readinessJob: readinessJob{ID: id, Generation: generation}}, now, updates)
			checked := d.sendReadiness[id].Availability
			switch change {
			case "revision":
				observation.Revision++
			case "owner":
				observation.OwnerID = "replacement-owner"
			case "disconnect":
				observation.Availability = "unavailable"
			case "busy":
				observation.Status = "active"
			case "unknown":
				observation.Status = "unknown"
			}
			d.publishDesktop(id, observation, updates)
			if got := d.cachedSessions()[0].SendAvailability; got.State == protocol.SendReady || got.ObservedAt != checked.ObservedAt {
				t.Fatalf("changed proof retained ready or renewed check time: %+v", got)
			}
			if observation.Status != "idle" || observation.Availability != "available" {
				if jobs := d.readinessSweep(now.Add(readinessRecovery), map[string]bool{}, 2, updates); len(jobs) != 0 {
					t.Fatal("non-idle or disconnected target scheduled a probe")
				}
				observation.Status, observation.Availability = "idle", "available"
				d.publishDesktop(id, observation, updates)
			}
			retryAt := now.Add(readinessRecovery)
			if got := d.sendReadiness[id].NextCheck; !got.Equal(retryAt) {
				t.Fatalf("idle recovery did not replace periodic wait: got=%v want=%v", got, retryAt)
			}
			if jobs := d.readinessSweep(retryAt.Add(-time.Nanosecond), map[string]bool{}, 2, updates); len(jobs) != 0 {
				t.Fatal("idle recovery bypassed minimum probe interval")
			}
			jobs := d.readinessSweep(retryAt, map[string]bool{}, 2, updates)
			if len(jobs) != 1 || jobs[0].Generation == generation {
				t.Fatalf("recovery did not check the replacement proof: %+v", jobs)
			}
			d.completeReadiness(readinessResult{readinessJob: jobs[0]}, retryAt, updates)
			if got := d.sendReadiness[id].Availability; got.State != protocol.SendReady {
				t.Fatalf("fresh probe did not restore ready: %+v", got)
			}
		})
	}
}

func TestReadinessFailuresKeepBackoffAcrossProofChanges(t *testing.T) {
	for _, probeError := range []error{errors.New("rejected"), codexdesktop.ErrDesktopSendBusy, context.DeadlineExceeded} {
		t.Run(probeError.Error(), func(t *testing.T) {
			d := newReadinessFixture(t)
			updates := make(chan struct{}, 1)
			now, id := time.Now(), "fixture-session"
			observation := idleReadinessObservation(now, 1)
			d.publishDesktop(id, observation, updates)
			job := readinessJob{ID: id, Generation: d.desktopGeneration[id]}
			// Even an obsolete probe's genuine failure keeps the failure cooldown.
			observation.Revision++
			d.publishDesktop(id, observation, updates)
			d.completeReadiness(readinessResult{readinessJob: job, Err: probeError}, now, updates)
			for range 3 {
				d.invalidateDesktop(updates)
				observation.Revision++
				d.publishDesktop(id, observation, updates)
			}
			retryAt := now.Add(readinessRecheck)
			if got := d.sendReadiness[id].NextCheck; !got.Equal(retryAt) {
				t.Fatalf("new proof bypassed genuine failure cooldown: got=%v want=%v", got, retryAt)
			}
			if jobs := d.readinessSweep(retryAt.Add(-time.Nanosecond), map[string]bool{}, 2, updates); len(jobs) != 0 {
				t.Fatal("failed probe retried before failure cooldown")
			}
			if jobs := d.readinessSweep(retryAt, map[string]bool{}, 2, updates); len(jobs) != 1 {
				t.Fatal("failure cooldown did not eventually allow recheck")
			}
		})
	}
}

func TestReadinessRevisionStormIsRateLimitedAndFair(t *testing.T) {
	d := newReadinessFixture(t)
	updates := make(chan struct{}, 1)
	now, id := time.Now(), "a-storm"
	d.sessionSnapshot = []protocol.Session{{ID: id}, {ID: "z-unchecked"}}
	observation := idleReadinessObservation(now, 1)
	d.publishDesktop(id, observation, updates)
	for range 10 {
		jobs := d.readinessSweep(now, map[string]bool{}, 1, updates)
		if len(jobs) != 1 || jobs[0].ID != id {
			t.Fatalf("storm recovery was starved: %+v", jobs)
		}
		if jobs := d.readinessSweep(now, map[string]bool{id: true}, 2, updates); len(jobs) != 0 {
			t.Fatal("storm scheduled overlapping probes")
		}
		observation.Revision++
		d.publishDesktop(id, observation, updates)
		d.completeReadiness(readinessResult{readinessJob: jobs[0]}, now, updates)
		retryAt := now.Add(readinessRecovery)
		for range 20 {
			observation.Revision++
			d.publishDesktop(id, observation, updates)
		}
		if record := d.sendReadiness[id]; record.Availability.State == protocol.SendReady || !record.NextCheck.Equal(retryAt) {
			t.Fatalf("revision burst granted ready or moved recovery deadline: %+v", record)
		}
		if jobs := d.readinessSweep(retryAt.Add(-time.Nanosecond), map[string]bool{}, 2, updates); len(jobs) != 0 {
			t.Fatal("revision burst bypassed probe rate limit")
		}
		now = retryAt
	}
	d.publishDesktop("z-unchecked", idleReadinessObservation(time.Now(), 1), updates)
	if jobs := d.readinessSweep(now, map[string]bool{}, 1, updates); len(jobs) != 1 || jobs[0].ID != "z-unchecked" {
		t.Fatalf("storm starved an unchecked target: %+v", jobs)
	}
}
