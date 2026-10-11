package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/journal"
)

func main() {
	code := run(os.Args[1:], os.Stdout, os.Stderr)
	os.Exit(code)
}

func run(args []string, stdout, stderr io.Writer) int {
	opts, err := parseFlags(args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintf(stderr, "Error: %v\n", err)
		return 2
	}

	report, err := journal.Migrate(*opts)
	if err != nil {
		fmt.Fprintf(stderr, "Migration failed: %v\n", err)
		return 1
	}

	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(report); err != nil {
		fmt.Fprintf(stderr, "Encode report failed: %v\n", err)
		return 1
	}
	return 0
}

func parseFlags(args []string) (*journal.MigrationOptions, error) {
	fs := flag.NewFlagSet("journal-migrate", flag.ContinueOnError)

	defaultNodeID := strings.TrimSpace(os.Getenv("NODE_ID"))
	if defaultNodeID == "" {
		defaultNodeID = config.DefaultNodeID
	}

	defaultSock := strings.TrimSpace(os.Getenv("CODEX_APP_SERVER_SOCKET"))
	defaultStateDir := strings.TrimSpace(os.Getenv("DAEMON_STATE_DIR"))

	stateDir := fs.String("state-dir", defaultStateDir, "Private durable command journal directory; defaults to ~/.super-leader/daemon/<node hash>")
	nodeID := fs.String("node-id", defaultNodeID, "Node identifier (e.g. macair)")
	socketPath := fs.String("sock", defaultSock, "Path to Codex app-server Unix domain socket")
	fromURL := fs.String("from", config.DefaultControllerURL, "Previous Controller WebSocket URL")
	toURL := fs.String("to", "", "Target Controller WebSocket URL")
	receiptsPath := fs.String("receipts", "", "Optional path to JSON file with Controller terminal command receipts (required if journal contains accepted entries)")
	apply := fs.Bool("apply", false, "Apply the scope migration transactionally (default is read-only check)")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected positional arguments: %v", fs.Args())
	}

	resolvedNodeID := strings.TrimSpace(*nodeID)
	if resolvedNodeID == "" {
		return nil, errors.New("node-id must not be empty")
	}

	resolvedSock := strings.TrimSpace(*socketPath)
	if resolvedSock == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("failed to resolve user home directory for default socket path: %w", err)
		}
		resolvedSock = filepath.Join(home, config.CodexSocketRelPath)
	}

	resolvedStateDir := strings.TrimSpace(*stateDir)
	if resolvedStateDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve daemon state directory: %w", err)
		}
		digest := sha256.Sum256([]byte(resolvedNodeID))
		resolvedStateDir = filepath.Join(home, ".super-leader", "daemon", hex.EncodeToString(digest[:])[:16])
	}

	var receipts []journal.TerminalReceipt
	if strings.TrimSpace(*receiptsPath) != "" {
		var err error
		receipts, err = journal.LoadReceiptsFile(*receiptsPath)
		if err != nil {
			return nil, err
		}
	}

	return &journal.MigrationOptions{
		StateDir:   resolvedStateDir,
		NodeID:     resolvedNodeID,
		SocketPath: resolvedSock,
		FromURL:    strings.TrimSpace(*fromURL),
		ToURL:      strings.TrimSpace(*toURL),
		Receipts:   receipts,
		Apply:      *apply,
	}, nil
}
