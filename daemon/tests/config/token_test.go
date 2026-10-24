package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

func TestParseFlagsRejectsInvalidRuntimeToken(t *testing.T) {
	for _, source := range []string{"env", "file"} {
		for _, action := range []string{"", config.ServiceActionInstall} {
			for _, tc := range []struct{ name, token string }{
				{"multiline", "fixture\ninvalid"},
				{"carriage-return", "fixture\rinvalid"},
				{"nul", "fixture\x00invalid"},
			} {
				if source == "env" && tc.name == "nul" {
					continue // Environment variables cannot contain NUL bytes.
				}
				t.Run(source+"/"+action+"/"+tc.name, func(t *testing.T) {
					args := []string{"--controller-url", config.DefaultControllerURL}
					if action != "" {
						args = append(args, "--service", action)
					}
					if source == "env" {
						const tokenEnv = "SERVICE_INSTALL_FIXTURE_TOKEN"
						t.Setenv(tokenEnv, tc.token)
						args = append(args, "--token-env", tokenEnv)
					} else {
						path := filepath.Join(t.TempDir(), "token")
						if err := os.WriteFile(path, []byte(tc.token), 0600); err != nil {
							t.Fatal(err)
						}
						args = append(args, "--token-file", path)
					}
					if _, err := config.ParseFlags(args); err == nil || !strings.Contains(err.Error(), "node token") {
						t.Fatalf("invalid token was not rejected: %v", err)
					}
				})
			}
		}
	}
}

func TestParseFlagsPreservesTrimmedSingleLineTokenFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("  fixture-valid-token\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.ParseFlags([]string{"--service", config.ServiceActionInstall, "--token-file", path, "--controller-url", config.DefaultControllerURL})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.NodeToken != "fixture-valid-token" {
		t.Fatal("single-line token file normalization changed")
	}
}
