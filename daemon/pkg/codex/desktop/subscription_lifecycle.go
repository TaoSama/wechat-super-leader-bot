package desktop

import (
	"encoding/json"
	"slices"
)

func desktopSubscriptionRevoked(message desktopEnvelope, clientID, id, owner string) bool {
	if message.Method == desktopClientStatusChanged {
		disconnected, status, valid := desktopClientStatus(message)
		return valid && status == "disconnected" && disconnected == owner
	}
	if message.Type != "broadcast" || message.Method != desktopFollowingChanged || message.Version != 1 ||
		message.SourceClientID != owner || !slices.Contains(message.TargetClientIDs, clientID) {
		return false
	}
	var params struct {
		ConversationID string `json:"conversationId"`
		HostID         string `json:"hostId"`
		Following      *bool  `json:"following"`
	}
	return historyControlObject(message.Params, []string{"conversationId", "hostId", "following"}, nil) &&
		json.Unmarshal(message.Params, &params) == nil && params.ConversationID == id && params.HostID == "local" &&
		params.Following != nil && !*params.Following
}
