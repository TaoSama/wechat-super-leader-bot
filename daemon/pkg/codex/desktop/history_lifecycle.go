package desktop

import (
	"bytes"
	"encoding/json"
	"io"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	desktopClientStatusChanged     = "client-status-changed"
	desktopClientDiscoveryRequest  = "client-discovery-request"
	desktopClientDiscoveryResponse = "client-discovery-response"
	desktopControlTimeoutLimit     = 10 * time.Minute
)

// These router control frames cannot establish a history subscription. Unknown
// fields and duplicate keys remain noise instead of widening the exemption.
func historyControlFrameShape(data []byte, message desktopEnvelope) bool {
	var required, optional []string
	switch {
	case message.Type == "broadcast" && message.Method == desktopClientStatusChanged:
		required = []string{"type", "method", "sourceClientId", "version", "params"}
	case message.Type == desktopClientDiscoveryRequest:
		required = []string{"type", "requestId", "request"}
		optional = []string{"version"}
	default:
		return true
	}
	return historyControlObject(data, required, optional)
}

func historyControlObject(data []byte, required, optional []string) bool {
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, name := range append(append([]string{}, required...), optional...) {
		allowed[name] = true
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return false
	}
	seen := make(map[string]bool, len(allowed))
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || !allowed[name] || seen[name] {
			return false
		}
		seen[name] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return false
	}
	if _, err = decoder.Token(); err != io.EOF {
		return false
	}
	for _, name := range required {
		if !seen[name] {
			return false
		}
	}
	return true
}

func historyControlUUID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for index, character := range id {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
		} else if !(character >= '0' && character <= '9' || character >= 'a' && character <= 'f' || character >= 'A' && character <= 'F') {
			return false
		}
	}
	return true
}

func desktopRouterControlEnvelope(message desktopEnvelope) bool {
	return !message.historyControlMalformed && message.Version == 0 && message.TargetClientID == "" && len(message.TargetClientIDs) == 0 &&
		message.ResultType == "" && message.HandledByClientID == "" && len(message.Result) == 0 && len(message.Response) == 0 && message.TimeoutMS == 0
}

func desktopClientStatus(message desktopEnvelope) (clientID, status string, valid bool) {
	if !desktopRouterControlEnvelope(message) || message.Type != "broadcast" || message.Method != desktopClientStatusChanged {
		return "", "", false
	}
	var params struct {
		ClientID   string `json:"clientId"`
		ClientType string `json:"clientType"`
		Status     string `json:"status"`
	}
	if message.RequestID != "" || len(message.Request) != 0 || !historyControlUUID(message.SourceClientID) ||
		!historyControlObject(message.Params, []string{"clientId", "clientType", "status"}, nil) || json.Unmarshal(message.Params, &params) != nil ||
		params.ClientID != message.SourceClientID || !protocol.ValidTurnID(params.ClientType) || (params.Status != "connected" && params.Status != "disconnected") {
		return "", "", false
	}
	return params.ClientID, params.Status, true
}

func (stream *desktopHistoryStream) routerControl(message desktopEnvelope) (bool, error) {
	if !desktopRouterControlEnvelope(message) {
		return false, nil
	}
	if message.Type == "broadcast" && message.Method == desktopClientStatusChanged {
		clientID, status, valid := desktopClientStatus(message)
		if !valid {
			return false, nil
		}
		if status == "disconnected" && clientID == stream.owner && stream.owner != "" {
			return true, historyFailure(protocol.HistoryContextExpired, historyFailureOwner)
		}
		return true, nil
	}
	if message.Type != desktopClientDiscoveryRequest || message.Method != "" || message.SourceClientID != "" || len(message.Params) != 0 || !historyControlUUID(message.RequestID) {
		return false, nil
	}
	var request struct {
		Type           string          `json:"type"`
		RequestID      string          `json:"requestId"`
		SourceClientID string          `json:"sourceClientId"`
		TargetClientID string          `json:"targetClientId"`
		Method         string          `json:"method"`
		Version        int             `json:"version"`
		Params         json.RawMessage `json:"params"`
		TimeoutMS      int             `json:"timeoutMs"`
	}
	if !historyControlObject(message.Request, []string{"type", "requestId", "sourceClientId", "method", "version", "params"}, []string{"targetClientId", "timeoutMs"}) ||
		json.Unmarshal(message.Request, &request) != nil || request.Type != "request" || request.Method != desktopDiscoverOwner || request.Version != 1 ||
		!historyControlUUID(request.RequestID) || !historyControlUUID(request.SourceClientID) || (request.TargetClientID != "" && !historyControlUUID(request.TargetClientID)) ||
		request.TimeoutMS < 0 || request.TimeoutMS > int(desktopControlTimeoutLimit.Milliseconds()) {
		return false, nil
	}
	var params struct {
		ConversationID string `json:"conversationId"`
		HostID         string `json:"hostId"`
	}
	if !historyControlObject(request.Params, []string{"conversationId", "hostId"}, nil) || json.Unmarshal(request.Params, &params) != nil ||
		!protocol.ValidTurnID(params.ConversationID) || params.HostID != "local" {
		return false, nil
	}
	// A read-only history client has no request handlers or ownership authority.
	if err := stream.connection.SetWriteDeadline(time.Now().Add(desktopRequestTimeout)); err != nil {
		return true, historyFailure(protocol.HistoryUnavailable, historyFailureRequestWrite)
	}
	if err := stream.connection.write(desktopEnvelope{Type: desktopClientDiscoveryResponse, RequestID: message.RequestID, Response: json.RawMessage(`{"canHandle":false}`)}); err != nil {
		return true, historyFailure(protocol.HistoryUnavailable, historyFailureRequestWrite)
	}
	return true, nil
}
