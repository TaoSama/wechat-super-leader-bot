package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"golang.org/x/sys/unix"
)

// openMediaFile walks every directory without following symlinks, then fstats
// the opened descriptor. Nonblocking opens cannot hang on FIFOs or devices.
func openMediaFile(path string) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New(protocol.MediaUnavailable)
	}
	parts := strings.Split(strings.TrimPrefix(path, string(filepath.Separator)), string(filepath.Separator))
	fd, err := unix.Open(string(filepath.Separator), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New(protocol.MediaUnavailable)
	}
	for i, part := range parts {
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
		if i < len(parts)-1 {
			flags |= unix.O_DIRECTORY
		}
		next, openErr := unix.Openat(fd, part, flags, 0)
		closeErr := unix.Close(fd)
		if openErr != nil {
			if closeErr != nil {
				log.Printf("media directory cleanup failed: %v", closeErr)
			}
			return nil, errors.New(protocol.MediaUnavailable)
		}
		if closeErr != nil {
			if err := unix.Close(next); err != nil {
				log.Printf("media descriptor cleanup failed: %v", err)
			}
			return nil, errors.New(protocol.MediaFailed)
		}
		fd = next
	}
	file := os.NewFile(uintptr(fd), "session-media")
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > protocol.MaxMediaBytes {
		closeMediaFile(file)
		return nil, errors.New(protocol.MediaUnavailable)
	}
	return file, nil
}

func closeMediaFile(file *os.File) {
	if err := file.Close(); err != nil {
		log.Printf("media file cleanup failed: %v", err)
	}
}

type mediaFileSnapshot struct {
	info         os.FileInfo
	mime, digest string
	size         int64
}

func mediaMIME(header []byte) string {
	switch {
	case bytes.HasPrefix(header, []byte{137, 80, 78, 71, 13, 10, 26, 10}):
		return "image/png"
	case len(header) >= 3 && header[0] == 255 && header[1] == 216 && header[2] == 255:
		return "image/jpeg"
	case bytes.HasPrefix(header, []byte("GIF87a")) || bytes.HasPrefix(header, []byte("GIF89a")):
		return "image/gif"
	case len(header) >= 12 && string(header[:4]) == "RIFF" && string(header[8:12]) == "WEBP":
		return "image/webp"
	default:
		return ""
	}
}

func snapshotMediaFile(ctx context.Context, file *os.File, offset int64, count int) (mediaFileSnapshot, []byte, error) {
	var snapshot mediaFileSnapshot
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() <= 0 || before.Size() > protocol.MaxMediaBytes {
		return snapshot, nil, errors.New(protocol.MediaUnavailable)
	}
	if offset > before.Size() {
		return snapshot, nil, errors.New(protocol.MediaInvalidRequest)
	}
	hash := sha256.New()
	buffer := make([]byte, 32*1024)
	chunk := make([]byte, 0, count)
	header := []byte{}
	var position int64
	for {
		if err := ctx.Err(); err != nil {
			return snapshot, nil, err
		}
		n, readErr := file.Read(buffer)
		if n > 0 {
			if position+int64(n) > protocol.MaxMediaBytes {
				return snapshot, nil, errors.New(protocol.MediaUnavailable)
			}
			if len(header) == 0 {
				header = append(header, buffer[:min(n, 12)]...)
			}
			if _, err := hash.Write(buffer[:n]); err != nil {
				return snapshot, nil, errors.New(protocol.MediaFailed)
			}
			start, end := max(offset, position), min(offset+int64(count), position+int64(n))
			if start < end {
				chunk = append(chunk, buffer[start-position:end-position]...)
			}
			position += int64(n)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return snapshot, nil, errors.New(protocol.MediaFailed)
		}
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || before.Size() != position || !before.ModTime().Equal(after.ModTime()) {
		return snapshot, nil, errors.New(protocol.MediaContextExpired)
	}
	mime := mediaMIME(header)
	if mime == "" {
		return snapshot, nil, errors.New(protocol.MediaUnavailable)
	}
	return mediaFileSnapshot{info: after, mime: mime, digest: hex.EncodeToString(hash.Sum(nil)), size: position}, chunk, nil
}
