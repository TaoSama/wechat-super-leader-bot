package service

import (
	"errors"
	"path/filepath"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

const TokenFileName = "service-node-token"

func ResolveTokenFilePath(stateDir string) string { return filepath.Join(stateDir, TokenFileName) }

func validateTokenFileInput(stateDir, token string) error {
	if err := config.ValidateNodeToken(token); err != nil {
		return err
	}
	if !filepath.IsAbs(stateDir) || strings.ContainsAny(stateDir, "\x00\r\n") {
		return errors.New("state-dir must be an absolute directory path without control characters")
	}
	return nil
}

func WritePrivateTokenFile(stateDir, token string) (string, error) {
	if err := EnsureNotRoot(); err != nil {
		return "", err
	}
	if err := validateTokenFileInput(stateDir, token); err != nil {
		return "", err
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
