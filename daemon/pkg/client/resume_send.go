package client

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func freshManagedResumeTarget(session protocol.Session, now time.Time) bool {
	return freshManagedResumeQueueTarget(session, now) &&
		(session.Status == "idle" || session.Status == "notLoaded")
}

func freshManagedResumeQueueTarget(session protocol.Session, now time.Time) bool {
	observed, err := time.Parse(time.RFC3339Nano, session.ObservedAt)
	busy := session.Status == "active" || session.Status == "waitingApproval" || session.Status == "waitingUserInput"
	return err == nil && !observed.After(now) && now.Sub(observed) <= protocol.MaxSendAvailabilityAge &&
		session.Provider == codex.ProviderCodexApp && !isTerminalSession(session.ID) &&
		session.Loaded != nil && (session.Status == "idle" || (!*session.Loaded && session.Status == "notLoaded") || (*session.Loaded && busy)) &&
		slices.Contains(session.Capabilities, protocol.CapabilityResumeSend)
}

func freshDesktopOwner(observation protocol.DesktopObservation, now time.Time) bool {
	observed, err := time.Parse(time.RFC3339Nano, observation.ObservedAt)
	return err == nil && !observed.After(now) && now.Sub(observed) <= protocol.MaxSendAvailabilityAge &&
		observation.Source == "codex-desktop" && observation.Availability == "available" && observation.OwnerID != ""
}

// Caller holds snapshotMu. A file scan or an expired observation cannot grant
// this capability. It is permission to attempt an explicit send, never ready.
func (d *Daemon) canResumeSendLocked(id string, now time.Time) bool {
	session, exists := d.managedSessionLocked(id)
	return exists && d.canQueueResumeSendLocked(id, now) && freshManagedResumeTarget(session, now)
}

// Queue permission never authorizes a resume or turn/start while the target is busy.
func (d *Daemon) canQueueResumeSendLocked(id string, now time.Time) bool {
	sender, ok := d.adapter.(codex.ResumeSender)
	if !ok || !d.durableJournal || d.journal == nil || d.cfg.SocketPath == "" || sender.Endpoint() != d.cfg.SocketPath ||
		freshDesktopOwner(d.desktopSnapshot[id], now) {
		return false
	}
	session, exists := d.managedSessionLocked(id)
	return exists && freshManagedResumeQueueTarget(session, now)
}

func (d *Daemon) sendWithResume(ctx context.Context, cmd protocol.ControllerCommandMessage, prompt string) (string, error) {
	d.snapshotMu.RLock()
	eligible := d.canResumeSendLocked(cmd.SessionID, time.Now())
	d.snapshotMu.RUnlock()
	if !eligible {
		return "", errors.New("resume-send requires a fresh managed target, durable journal, and no available desktop owner")
	}
	sender, ok := d.adapter.(codex.ResumeSender)
	if !ok {
		return "", errors.New("configured adapter cannot resume-send")
	}
	entry, found, err := d.journal.Lookup(cmd)
	if err != nil || !found || entry.Finished || entry.Dispatch == nil || entry.Dispatch.Route != protocol.RouteAppServerResume {
		return "", &codex.UncertainError{Err: errors.New("resume-send durable dispatch claim unavailable; no input sent")}
	}
	identity := *entry.Dispatch
	identity.Endpoint = sender.Endpoint()
	if err := d.journal.BindDispatch(cmd, identity); err != nil {
		return "", &codex.UncertainError{Err: errors.New("resume-send endpoint could not be persisted; no input sent")}
	}
	if cmd.IsExpired() || ctx.Err() != nil {
		return "", errors.New("resume-send command expired before mutation")
	}
	turnID, err := sender.ResumeSend(ctx, cmd.SessionID, prompt)
	if err != nil {
		return "", err
	}
	if !protocol.ValidTurnID(turnID) {
		return "", &codex.UncertainError{Err: errors.New(protocol.InvalidTurnAcknowledgement)}
	}
	return "turnId=" + turnID, nil
}
