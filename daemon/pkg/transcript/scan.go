package transcript

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type locatedItem struct {
	start int64
	item  protocol.HistoryItem
}

func prefixDigest(ctx context.Context, file *os.File, size int64) ([32]byte, error) {
	h := sha256.New()
	reader := io.NewSectionReader(file, 0, size)
	buffer := make([]byte, 64<<10)
	var copied int64
	for {
		if err := ctx.Err(); err != nil {
			return [32]byte{}, err
		}
		n, err := reader.Read(buffer)
		if n > 0 {
			if _, writeErr := h.Write(buffer[:n]); writeErr != nil {
				return [32]byte{}, failure(protocol.HistoryFailed)
			}
			copied += int64(n)
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return [32]byte{}, failure(protocol.HistoryIncomplete)
		}
	}
	if copied != size {
		return [32]byte{}, failure(protocol.HistoryContextExpired)
	}
	var digest [32]byte
	copy(digest[:], h.Sum(nil))
	return digest, nil
}

func (r *Reader) readFile(ctx context.Context, ref Ref, state *generationState, upper int64, limit int) (page Page, err error) {
	anchor, err := openAnchor(r.roots[ref.Agent])
	if err != nil {
		if state.file != nil {
			return Page{}, failure(protocol.HistoryContextExpired)
		}
		return Page{}, err
	}
	defer func() {
		err = errors.Join(err, closeFile(anchor))
		if err != nil {
			page = Page{}
		}
	}()
	rootInfo, err := anchor.Stat()
	if err != nil {
		return Page{}, failure(protocol.HistoryUnavailable)
	}
	if state.root != nil && !os.SameFile(rootInfo, state.root) {
		return Page{}, failure(protocol.HistoryContextExpired)
	}
	rel, err := resolve(ctx, anchor, ref)
	if err != nil {
		if state.file != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) && err.Error() != protocol.HistoryTooLarge {
			return Page{}, failure(protocol.HistoryContextExpired)
		}
		return Page{}, err
	}
	if state.path != "" && state.path != rel {
		return Page{}, failure(protocol.HistoryContextExpired)
	}
	file, err := openRelative(anchor, rel)
	if err != nil {
		if state.file != nil {
			return Page{}, failure(protocol.HistoryContextExpired)
		}
		return Page{}, err
	}
	defer func() {
		err = errors.Join(err, closeFile(file))
		if err != nil {
			page = Page{}
		}
	}()
	info, err := file.Stat()
	if err != nil {
		return Page{}, failure(protocol.HistoryUnavailable)
	}
	if info.Size() > MaxFileBytes {
		return Page{}, failure(protocol.HistoryTooLarge)
	}
	if state.file != nil {
		if !os.SameFile(state.file, info) || info.Size() < state.boundary {
			return Page{}, failure(protocol.HistoryContextExpired)
		}
		digest, err := prefixDigest(ctx, file, state.boundary)
		if err != nil {
			return Page{}, err
		}
		if digest != state.digest {
			return Page{}, failure(protocol.HistoryContextExpired)
		}
	}
	if upper > state.boundary {
		return Page{}, failure(protocol.HistoryContextExpired)
	}
	page.Items = []protocol.HistoryItem{}
	lines := bufio.NewReaderSize(io.NewSectionReader(file, 0, info.Size()), 64<<10)
	ring := make([]locatedItem, 0, limit+1)
	position, total := int64(0), 0
	recognized, first := false, true
	h := sha256.New()
	for {
		if err := ctx.Err(); err != nil {
			return Page{}, err
		}
		line := make([]byte, 0, 4096)
		var readErr error
		for {
			fragment, fragmentErr := lines.ReadSlice('\n')
			if len(line)+len(fragment) > MaxLineBytes {
				return Page{}, failure(protocol.HistoryTooLarge)
			}
			line = append(line, fragment...)
			if errors.Is(fragmentErr, bufio.ErrBufferFull) {
				continue
			}
			readErr = fragmentErr
			break
		}
		if errors.Is(readErr, io.EOF) {
			if len(line) > 0 {
				page.Truncated = true
			}
			break
		}
		if readErr != nil {
			return Page{}, failure(protocol.HistoryIncomplete)
		}
		start := position
		position += int64(len(line))
		if _, err := h.Write(line); err != nil {
			return Page{}, failure(protocol.HistoryFailed)
		}
		item, known, parseErr := parseRecord(ctx, line[:len(line)-1], ref, first)
		if parseErr != nil {
			return Page{}, parseErr
		}
		first = false
		recognized = recognized || known
		if item.Text == "" || upper >= 0 && position > upper {
			continue
		}
		idHash := sha256.Sum256([]byte(strconv.FormatInt(start, 10) + "\x00" + string(line)))
		item.ID = "transcript:" + base64.RawURLEncoding.EncodeToString(idHash[:18])
		total++
		if len(ring) == limit+1 {
			copy(ring, ring[1:])
			ring = ring[:limit]
		}
		ring = append(ring, locatedItem{start, item})
	}
	if !recognized {
		return Page{}, failure(protocol.HistoryUnavailable)
	}
	var digest [32]byte
	copy(digest[:], h.Sum(nil))
	verified, err := prefixDigest(ctx, file, position)
	if err != nil {
		return Page{}, err
	}
	if verified != digest {
		return Page{}, failure(protocol.HistoryContextExpired)
	}
	if err := verifyLocation(ctx, anchor, r.roots[ref.Agent], ref, rel, info); err != nil {
		return Page{}, err
	}
	// Select newest items within both count and encoded-size budgets. Keeping
	// the oldest selected byte boundary allows the omitted items on the next page.
	startIndex, encodedBytes := len(ring), 2
	for index := len(ring) - 1; index >= 0 && len(ring)-startIndex < limit; index-- {
		encoded, err := json.Marshal(ring[index].item)
		if err != nil {
			return Page{}, failure(protocol.HistoryFailed)
		}
		if encodedBytes+len(encoded)+1 > MaxPageBytes {
			page.Truncated = true
			break
		}
		encodedBytes += len(encoded) + 1
		startIndex = index
	}
	for _, entry := range ring[startIndex:] {
		page.Items = append(page.Items, entry.item)
		page.Truncated = page.Truncated || entry.item.Truncated
	}
	if total > len(page.Items) && len(page.Items) > 0 {
		next := strconv.FormatInt(ring[startIndex].start, 10)
		page.NextCursor = &next
	}
	if err := ctx.Err(); err != nil {
		return Page{}, err
	}
	state.root, state.file, state.path, state.boundary, state.digest = rootInfo, info, rel, position, digest
	return page, nil
}

func verifyLocation(ctx context.Context, anchor *os.File, path string, ref Ref, rel string, expected os.FileInfo) (err error) {
	freshRoot, err := openAnchor(path)
	if err != nil {
		return failure(protocol.HistoryContextExpired)
	}
	defer func() { err = errors.Join(err, closeFile(freshRoot)) }()
	oldInfo, err := anchor.Stat()
	if err != nil {
		return failure(protocol.HistoryContextExpired)
	}
	newInfo, err := freshRoot.Stat()
	if err != nil || !os.SameFile(oldInfo, newInfo) {
		return failure(protocol.HistoryContextExpired)
	}
	currentPath, err := resolve(ctx, freshRoot, ref)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || err.Error() == protocol.HistoryTooLarge {
			return err
		}
		return failure(protocol.HistoryContextExpired)
	}
	if currentPath != rel {
		return failure(protocol.HistoryContextExpired)
	}
	freshFile, err := openRelative(freshRoot, rel)
	if err != nil {
		return failure(protocol.HistoryContextExpired)
	}
	defer func() { err = errors.Join(err, closeFile(freshFile)) }()
	current, err := freshFile.Stat()
	if err != nil || !os.SameFile(expected, current) || current.Size() < expected.Size() {
		return failure(protocol.HistoryContextExpired)
	}
	if current.Size() > MaxFileBytes {
		return failure(protocol.HistoryTooLarge)
	}
	return nil
}
