package protocol

import "time"

const MaxSendAvailabilityAge = 45 * time.Second

type SendAvailabilityState string
type SendAvailabilityReason string

const (
	SendReady       SendAvailabilityState = "ready"
	SendBlocked     SendAvailabilityState = "blocked"
	SendUnavailable SendAvailabilityState = "unavailable"

	SendReasonBusy              SendAvailabilityReason = "busy"
	SendReasonPreflightRejected SendAvailabilityReason = "preflight-rejected"
	SendReasonUnavailable       SendAvailabilityReason = "unavailable"
	SendReasonChecking          SendAvailabilityReason = "checking"
)

// SendAvailability is an expiring admission hint, not permission to mutate.
// Desktop execution must still perform a fresh same-owner preflight.
type SendAvailability struct {
	Route      SendRoute              `json:"route"`
	State      SendAvailabilityState  `json:"state"`
	ObservedAt string                 `json:"observedAt"`
	ValidUntil string                 `json:"validUntil"`
	Reason     SendAvailabilityReason `json:"reason,omitempty"`
	Mode       string                 `json:"mode,omitempty"`
}
