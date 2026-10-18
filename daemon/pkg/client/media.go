package client

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const maxMediaContexts = 32
const mediaContextTTL = 5 * time.Minute
const mediaReadTimeout = 8 * time.Second
const maxConcurrentMediaReads = 4

type sessionMediaReader interface {
	ListSessionMedia(context.Context, string, string, string, string, int) ([]protocol.NativeMediaReference, string, error)
	ValidateMediaGeneration(context.Context, string, string) error
}

type mediaBinding struct {
	nodeID, sessionID, source, generation, token, itemID, turnID string
	expiresAt                                                    time.Time
	reader                                                       sessionMediaReader
	files                                                        map[string]boundMediaFile
	order                                                        []protocol.MediaDescriptor
}
type boundMediaFile struct {
	ref        protocol.NativeMediaReference
	snapshot   mediaFileSnapshot
	descriptor protocol.MediaDescriptor
}
type mediaState struct {
	mu       sync.Mutex
	bindings map[string]*mediaBinding
	slots    chan struct{}
}

func newMediaState() *mediaState {
	return &mediaState{bindings: make(map[string]*mediaBinding), slots: make(chan struct{}, maxConcurrentMediaReads)}
}

func (d *Daemon) resetMedia() {
	d.mediaState.mu.Lock()
	defer d.mediaState.mu.Unlock()
	d.mediaState.bindings = make(map[string]*mediaBinding)
}

func (d *Daemon) mediaReader(sessionID string) (sessionMediaReader, string) {
	if isTerminalSession(sessionID) {
		return nil, ""
	}
	source := d.preferredHistorySource(sessionID)
	if source == protocol.HistorySourceDesktop {
		reader, _ := d.desktopHistory.(sessionMediaReader)
		return reader, source
	}
	reader, _ := d.adapter.(sessionMediaReader)
	return reader, source
}

func (d *Daemon) mediaContext(nodeID, sessionID, token string) *mediaBinding {
	d.mediaState.mu.Lock()
	defer d.mediaState.mu.Unlock()
	now := time.Now()
	for id, binding := range d.mediaState.bindings {
		if !now.Before(binding.expiresAt) {
			delete(d.mediaState.bindings, id)
		}
	}
	binding := d.mediaState.bindings[token]
	if binding == nil || binding.nodeID != nodeID || binding.sessionID != sessionID {
		return nil
	}
	return binding
}

func mediaError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return protocol.MediaTimeout
	}
	if err != nil {
		switch err.Error() {
		case protocol.MediaInvalidRequest, protocol.MediaUnavailable, protocol.MediaContextExpired, protocol.MediaBusy:
			return err.Error()
		case protocol.HistoryUnavailable:
			return protocol.MediaUnavailable
		case protocol.HistoryContextExpired:
			return protocol.MediaContextExpired
		}
	}
	return protocol.MediaFailed
}

func (d *Daemon) ListMedia(ctx context.Context, msg protocol.ListMediaMessage) protocol.DaemonMediaListMessage {
	response := protocol.DaemonMediaListMessage{Type: "media_list", RequestID: mediaResponseIdentity(msg.RequestID), SessionID: mediaResponseIdentity(msg.SessionID)}
	if err := msg.Validate(d.cfg.NodeID); err != nil {
		response.Error = protocol.MediaInvalidRequest
		return response
	}
	select {
	case d.mediaState.slots <- struct{}{}:
		defer func() { <-d.mediaState.slots }()
	default:
		response.Error = protocol.MediaBusy
		return response
	}
	readCtx, cancel := context.WithTimeout(ctx, mediaReadTimeout)
	defer cancel()
	if msg.MediaContext != "" {
		binding := d.mediaContext(msg.NodeID, msg.SessionID, msg.MediaContext)
		if binding == nil || binding.itemID != msg.ItemID || binding.turnID != msg.TurnID {
			response.Error = protocol.MediaContextExpired
			return response
		}
		if err := binding.reader.ValidateMediaGeneration(readCtx, binding.sessionID, binding.generation); err != nil {
			response.Error = mediaError(err)
			return response
		}
		response.MediaContext, response.Source, response.Media = binding.token, binding.source, append([]protocol.MediaDescriptor{}, binding.order...)
		return response
	}
	reader, source := d.mediaReader(msg.SessionID)
	if reader == nil {
		response.Error = protocol.MediaUnavailable
		return response
	}
	refs, generation, err := reader.ListSessionMedia(readCtx, msg.SessionID, "", msg.ItemID, msg.TurnID, protocol.MaxSessionMedia)
	if err != nil && (err.Error() == protocol.MediaUnavailable || err.Error() == protocol.HistoryUnavailable) && readCtx.Err() == nil &&
		source == protocol.HistorySourceControl && d.desktopHistorySource(msg.SessionID) == protocol.HistorySourceDesktop {
		if desktopReader, ok := d.desktopHistory.(sessionMediaReader); ok {
			reader, source = desktopReader, protocol.HistorySourceDesktop
			refs, generation, err = reader.ListSessionMedia(readCtx, msg.SessionID, "", msg.ItemID, msg.TurnID, protocol.MaxSessionMedia)
		}
	}
	if err != nil {
		response.Error = mediaError(err)
		return response
	}
	if generation == "" || len(refs) > protocol.MaxSessionMedia {
		response.Error = protocol.MediaFailed
		return response
	}
	token, err := protocol.NewDispatchID()
	if err != nil {
		response.Error = protocol.MediaFailed
		return response
	}
	binding := &mediaBinding{nodeID: msg.NodeID, sessionID: msg.SessionID, source: source, generation: generation, token: token,
		itemID: msg.ItemID, turnID: msg.TurnID, reader: reader, files: map[string]boundMediaFile{}, order: []protocol.MediaDescriptor{}, expiresAt: time.Now().Add(mediaContextTTL)}
	for _, ref := range refs {
		if !protocol.ValidHistoryIdentity(ref.ItemID) || !protocol.ValidTurnID(ref.TurnID) || ref.Ordinal < 0 || msg.ItemID != "" && ref.ItemID != msg.ItemID || msg.TurnID != "" && ref.TurnID != msg.TurnID {
			response.Error = protocol.MediaFailed
			return response
		}
		file, err := openMediaFile(ref.Path)
		if err != nil {
			response.Error = protocol.MediaUnavailable
			return response
		}
		snapshot, _, err := snapshotMediaFile(readCtx, file, 0, 0)
		closeMediaFile(file)
		if err != nil {
			if readCtx.Err() != nil {
				response.Error = mediaError(readCtx.Err())
				return response
			}
			response.Error = protocol.MediaUnavailable
			return response
		}
		id, err := protocol.NewDispatchID()
		if err != nil {
			response.Error = protocol.MediaFailed
			return response
		}
		descriptor := protocol.MediaDescriptor{MediaID: id, ItemID: ref.ItemID, TurnID: ref.TurnID, Ordinal: ref.Ordinal, MIME: snapshot.mime, TotalSize: snapshot.size, SHA256: snapshot.digest}
		binding.files[id] = boundMediaFile{ref: ref, snapshot: snapshot, descriptor: descriptor}
		binding.order = append(binding.order, descriptor)
	}
	if err := reader.ValidateMediaGeneration(readCtx, msg.SessionID, generation); err != nil {
		response.Error = mediaError(err)
		return response
	}
	d.mediaState.mu.Lock()
	defer d.mediaState.mu.Unlock()
	for id, old := range d.mediaState.bindings {
		if !time.Now().Before(old.expiresAt) {
			delete(d.mediaState.bindings, id)
		}
	}
	if len(d.mediaState.bindings) >= maxMediaContexts {
		response.Error = protocol.MediaBusy
		return response
	}
	d.mediaState.bindings[token] = binding
	response.MediaContext, response.Source, response.Media = token, source, binding.order
	return response
}

func (d *Daemon) ReadMedia(ctx context.Context, msg protocol.ReadMediaMessage) protocol.DaemonMediaChunkMessage {
	response := protocol.DaemonMediaChunkMessage{Type: "media_chunk", RequestID: mediaResponseIdentity(msg.RequestID), SessionID: mediaResponseIdentity(msg.SessionID), Offset: msg.Offset}
	if protocol.ValidMediaToken(msg.MediaContext) {
		response.MediaContext = msg.MediaContext
	}
	if protocol.ValidMediaToken(msg.MediaID) {
		response.MediaID = msg.MediaID
	}
	if err := msg.Validate(d.cfg.NodeID); err != nil {
		response.Error = protocol.MediaInvalidRequest
		return response
	}
	select {
	case d.mediaState.slots <- struct{}{}:
		defer func() { <-d.mediaState.slots }()
	default:
		response.Error = protocol.MediaBusy
		return response
	}
	readCtx, cancel := context.WithTimeout(ctx, mediaReadTimeout)
	defer cancel()
	binding := d.mediaContext(msg.NodeID, msg.SessionID, msg.MediaContext)
	if binding == nil {
		response.Error = protocol.MediaContextExpired
		return response
	}
	bound, ok := binding.files[msg.MediaID]
	if !ok {
		response.Error = protocol.MediaContextExpired
		return response
	}
	if err := binding.reader.ValidateMediaGeneration(readCtx, msg.SessionID, binding.generation); err != nil {
		response.Error = mediaError(err)
		return response
	}
	file, err := openMediaFile(bound.ref.Path)
	if err != nil {
		response.Error = protocol.MediaContextExpired
		return response
	}
	defer closeMediaFile(file)
	snapshot, data, err := snapshotMediaFile(readCtx, file, msg.Offset, msg.MaxBytes)
	if err != nil {
		response.Error = mediaError(err)
		return response
	}
	if !os.SameFile(bound.snapshot.info, snapshot.info) || !bound.snapshot.info.ModTime().Equal(snapshot.info.ModTime()) || snapshot.size != bound.snapshot.size || snapshot.mime != bound.snapshot.mime || snapshot.digest != bound.snapshot.digest {
		response.Error = protocol.MediaContextExpired
		return response
	}
	if err := binding.reader.ValidateMediaGeneration(readCtx, msg.SessionID, binding.generation); err != nil {
		response.Error = mediaError(err)
		return response
	}
	if d.mediaContext(msg.NodeID, msg.SessionID, msg.MediaContext) != binding {
		response.Error = protocol.MediaContextExpired
		return response
	}
	response.TotalSize, response.MIME, response.SHA256 = snapshot.size, snapshot.mime, snapshot.digest
	response.Data, response.EOF = data, msg.Offset+int64(len(data)) == snapshot.size
	return response
}

func mediaResponseIdentity(value string) string {
	if protocol.ValidHistoryIdentity(value) {
		return value
	}
	return ""
}
