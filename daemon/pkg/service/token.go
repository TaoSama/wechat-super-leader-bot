package service

import (
	"errors"
	"path/filepath"
	"strings"
)

const TokenFileName = "service-node-token"

func ResolveTokenFilePath(stateDir string) string { return filepath.Join(stateDir, TokenFileName) }

func WritePrivateTokenFile(stateDir, token string) (string, error) {
	if err := EnsureNotRoot(); err != nil {
		return "", err
	}
	if strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\x00\r\n") {
		return "", errors.New("node token must be nonempty and single-line")
	}
	if !filepath.IsAbs(stateDir) {
		return "", errors.New("state-dir must be absolute")
	}
	if err := ensureOwnedDirectory(stateDir, true); err != nil {
		return "", err
	}
	path := ResolveTokenFilePath(stateDir)
	if err := AtomicWriteFile(path, []byte(token), 0600); err != nil {
		return "", err
	}
	return path, nil
}
