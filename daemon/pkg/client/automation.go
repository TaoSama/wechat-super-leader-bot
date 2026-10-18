package client

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/automation"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const automationReadTimeout = 12 * time.Second
const automationResponseLimit = 768 * 1024

type automationRequest struct {
	Type         string `json:"type"`
	RequestID    string `json:"requestId"`
	NodeID       string `json:"nodeId"`
	AutomationID string `json:"automationId"`
	ExpectedAt   int64  `json:"expectedAt"`
	NotAfter     int64  `json:"notAfter"`
}
type automationResponse struct {
	Type        string                 `json:"type"`
	RequestID   string                 `json:"requestId"`
	Automations *[]automation.Config   `json:"automations,omitempty"`
	Inspection  *automation.Inspection `json:"inspection,omitempty"`
	Error       string                 `json:"error,omitempty"`
}

func (d *Daemon) scheduleAutomationRead(ctx context.Context, data []byte, slots chan struct{}, workers *sync.WaitGroup, send func(any) error, failures chan<- error) error {
	var req automationRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return send(automationResponse{Type: "automation_response", Error: "automation_invalid_request"})
	}
	response := automationResponse{Type: "automation_response", RequestID: req.RequestID}
	if req.NodeID != d.cfg.NodeID || !protocol.ValidHistoryIdentity(req.RequestID) ||
		(req.Type != "list_automations" && req.Type != "inspect_automation") ||
		(req.Type == "inspect_automation" && !automation.ValidWindow(req.AutomationID, req.ExpectedAt, req.NotAfter)) {
		if !protocol.ValidHistoryIdentity(response.RequestID) {
			response.RequestID = ""
		}
		response.Error = "automation_invalid_request"
		return send(response)
	}
	select {
	case slots <- struct{}{}:
		requestCtx, cleanup, registered := d.historyRequests.register(ctx, protocol.ReadHistoryMessage{RequestID: req.RequestID, NodeID: req.NodeID, SessionID: "automation"})
		if !registered {
			<-slots
			response.Error = "automation_busy"
			return send(response)
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer cleanup()
			defer func() { <-slots }()
			readCtx, cancel := context.WithTimeout(requestCtx, automationReadTimeout)
			defer cancel()
			reader := automation.Reader{Home: d.cfg.CodexHome}
			var err error
			if req.Type == "list_automations" {
				var configs []automation.Config
				configs, err = reader.List(readCtx)
				if err == nil {
					response.Automations = &configs
				}
			} else {
				var result automation.Inspection
				result, err = reader.Inspect(readCtx, req.AutomationID, req.ExpectedAt, req.NotAfter)
				if err == nil {
					response.Inspection = &result
				}
			}
			if requestCtx.Err() != nil {
				return
			}
			if err != nil {
				response.Error = "automation_read_failed"
				if errors.Is(err, automation.ErrTooLarge) {
					response.Error = automation.ErrTooLarge.Error()
				}
				if readCtx.Err() != nil {
					response.Error = "automation_timeout"
				}
			}
			encoded, encodeErr := json.Marshal(response)
			if encodeErr != nil || len(encoded) > automationResponseLimit {
				response.Automations = nil
				response.Inspection = nil
				response.Error = automation.ErrTooLarge.Error()
			}
			if err = send(response); err != nil {
				select {
				case failures <- err:
				case <-ctx.Done():
				}
			}
		}()
		return nil
	default:
		response.Error = "automation_busy"
		return send(response)
	}
}
func (d *Daemon) cancelAutomation(data []byte) {
	var req automationRequest
	if json.Unmarshal(data, &req) != nil || req.Type != "cancel_automation" || req.NodeID != d.cfg.NodeID || !protocol.ValidHistoryIdentity(req.RequestID) {
		return
	}
	d.historyRequests.mu.Lock()
	defer d.historyRequests.mu.Unlock()
	if entry := d.historyRequests.pending[historyRequestKey{req.RequestID, req.NodeID, "automation"}]; entry != nil {
		entry.cancel()
	}
}
