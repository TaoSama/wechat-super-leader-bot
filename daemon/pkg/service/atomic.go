package service

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

func ownedByUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(stat.Uid) == os.Getuid()
}

func VerifySafeWriteTarget(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !ownedByUser(info) {
		return fmt.Errorf("target %s must be a regular file owned by the current user (no symlinks)", path)
	}
	return nil
}

func ensureOwnedDirectory(path string, private bool) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || !ownedByUser(info) || info.Mode().Perm()&0022 != 0 || (private && info.Mode().Perm()&0077 != 0) {
		return fmt.Errorf("directory %s must be owned, non-symlink and have safe permissions", path)
	}
	return nil
}

func AtomicWriteFile(dstPath string, data []byte, perm os.FileMode) error {
	return atomicWrite(dstPath, bytes.NewReader(data), perm)
}

func AtomicCopyFile(srcPath, dstPath string, perm os.FileMode) (err error) {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, src.Close()) }()
	return atomicWrite(dstPath, src, perm)
}

func atomicWrite(dstPath string, data io.Reader, perm os.FileMode) (err error) {
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	if !filepath.IsAbs(dstPath) {
		return errors.New("destination must be absolute")
	}
	if err := VerifySafeWriteTarget(dstPath); err != nil {
		return err
	}
	dir := filepath.Dir(dstPath)
	if err := ensureOwnedDirectory(dir, false); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".super-leader-install-*")
	if err != nil {
		return err
	}
	closed, renamed := false, false
	defer func() {
		if !closed {
			err = errors.Join(err, tmp.Close())
		}
		if !renamed {
			err = errors.Join(err, os.Remove(tmp.Name()))
		}
	}()
	if err := tmp.Chmod(perm); err != nil {
		return err
	}
	if _, err := io.Copy(tmp, data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	closeErr := tmp.Close()
	closed = true
	if closeErr != nil {
		return closeErr
	}
	if err := VerifySafeWriteTarget(dstPath); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), dstPath); err != nil {
		return err
	}
	renamed = true
	parent, err := os.Open(dir)
	if err != nil {
		return err
	}
	return errors.Join(parent.Sync(), parent.Close())
}
