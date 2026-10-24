package config

import (
	"errors"
	"strings"
)

// ValidateNodeToken checks credentials without exposing their contents in errors.
func ValidateNodeToken(token string) error {
	if strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\x00\r\n") {
		return errors.New("node token must be nonempty and single-line")
	}
	return nil
}
