//go:build !darwin && !linux

package transcript

import (
	"context"
	"os"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func openAnchor(string) (*os.File, error) { return nil, failure(protocol.HistoryUnavailable) }
func resolve(context.Context, *os.File, Ref) (string, error) {
	return "", failure(protocol.HistoryUnavailable)
}
func openRelative(*os.File, string) (*os.File, error) {
	return nil, failure(protocol.HistoryUnavailable)
}
func closeFile(file *os.File) error {
	if err := file.Close(); err != nil {
		return failure(protocol.HistoryFailed)
	}
	return nil
}
