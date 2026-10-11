package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	ManagedBinDirName  = ".local/share/super-leader/bin"
	ManagedBinFileName = "super-leader-daemon"
)

func ResolveManagedBinaryPath(customHome ...string) (string, error) {
	var home string
	if len(customHome) > 0 && customHome[0] != "" {
		home = customHome[0]
	} else {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve user home directory: %w", err)
		}
	}
	if !filepath.IsAbs(home) {
		return "", errors.New("home directory must be absolute")
	}
	return filepath.Join(home, ManagedBinDirName, ManagedBinFileName), nil
}

func InstallManagedBinary(srcPath, dstPath string) error {
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	if srcPath == "" {
		var err error
		srcPath, err = os.Executable()
		if err != nil {
			return err
		}
	}
	srcPath, err := filepath.EvalSymlinks(srcPath)
	if err != nil {
		return err
	}
	info, err := os.Stat(srcPath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("source executable must be a regular file")
	}
	return AtomicCopyFile(srcPath, dstPath, 0755)
}
