//go:build darwin || linux

package skills

import (
	"errors"
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

const skillDirectoryFDPath = "/dev/fd/"

func openSkillRoot(name string) (*os.Root, error) {
	dir, _, err := openSkillFile(nil, name, true)
	if err != nil {
		return nil, err
	}
	// OpenRoot opens before checking the type. Duplicate the held directory
	// instead of reopening a pathname that could now name a FIFO.
	root, openErr := os.OpenRoot(skillDirectoryFDPath + strconv.FormatUint(uint64(dir.Fd()), 10))
	closeErr := dir.Close()
	if openErr != nil {
		return nil, errors.Join(openErr, closeErr)
	}
	if closeErr != nil {
		return nil, errors.Join(closeErr, root.Close())
	}
	return root, nil
}

func openSkillFile(root *os.Root, name string, directory bool) (*os.File, os.FileInfo, error) {
	flags := os.O_RDONLY | unix.O_NONBLOCK
	if directory {
		flags |= unix.O_DIRECTORY
	}
	var file *os.File
	var err error
	if root == nil {
		// The configured root has already had its symlinks resolved.
		file, err = os.OpenFile(name, flags|unix.O_NOFOLLOW, 0)
	} else {
		// Root resolves in-root links while rejecting any escape, including a
		// link substituted after the scanner's Lstat.
		file, err = root.OpenFile(name, flags, 0)
	}
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil {
		return nil, nil, errors.Join(err, file.Close())
	}
	if directory && !info.IsDir() || !directory && !info.Mode().IsRegular() {
		return nil, nil, errors.Join(errors.New("skill path type changed"), file.Close())
	}
	return file, info, nil
}
