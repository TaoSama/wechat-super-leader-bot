package protocol

import (
	"unicode"
	"unicode/utf8"
)

const MaxTurnIDLength = 128
const InvalidTurnAcknowledgement = "Turn dispatch acknowledgement invalid; execution is unconfirmed, do not replay"

// ValidTurnID validates the exact opaque identifier without normalizing it.
func ValidTurnID(id string) bool {
	if id == "" || len(id) > MaxTurnIDLength || !utf8.ValidString(id) {
		return false
	}
	for _, character := range id {
		// A replacement character may conceal a JSON decoder's repair of an
		// invalid opaque identifier; it cannot establish an exact turn binding.
		if character == utf8.RuneError || unicode.IsSpace(character) || unicode.IsControl(character) {
			return false
		}
	}
	return true
}
