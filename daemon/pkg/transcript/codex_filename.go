package transcript

import (
	"strings"
	"time"
)

// codexRolloutKey orders immutable rollouts by their creation timestamp, then
// rollout UUID. A plain filename uses the thread UUID as its rollout UUID.
func codexRolloutKey(name, threadID string) (string, bool) {
	const prefix = "rollout-"
	const suffix = ".jsonl"
	const timestampLayout = "2006-01-02T15-04-05"
	if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
		return "", false
	}
	stem := strings.TrimSuffix(strings.TrimPrefix(name, prefix), suffix)
	separator := len(timestampLayout)
	if len(stem) <= separator || stem[separator] != '-' {
		return "", false
	}
	if _, err := time.Parse(timestampLayout, stem[:separator]); err != nil {
		return "", false
	}
	id, rolloutID, compound := strings.Cut(stem[separator+1:], "_")
	if id != threadID || !uuidID.MatchString(id) {
		return "", false
	}
	if !compound {
		rolloutID = id
	}
	if !uuidID.MatchString(rolloutID) {
		return "", false
	}
	return stem[:separator] + "\x00" + strings.ToLower(rolloutID), true
}
