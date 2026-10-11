package service

import (
	"strings"
	"testing"
)

func TestServiceRendersDesktopSendingOnlyWithExplicitFlag(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		cfg := sampleConfig(t, t.TempDir())
		cfg.DesktopSend = enabled
		for _, render := range []struct {
			name string
			call func() (string, error)
		}{
			{"launchd", func() (string, error) { return GeneratePlistXML("/fixture/daemon", cfg, "/fixture/token") }},
			{"systemd", func() (string, error) { return GenerateSystemdUnit("/fixture/daemon", cfg, "/fixture/token") }},
		} {
			data, err := render.call()
			if err != nil || strings.Contains(data, "--desktop-send") != enabled || !strings.Contains(data, "--desktop-sock") {
				t.Fatalf("%s changed explicit flag: enabled=%t data=%s err=%v", render.name, enabled, data, err)
			}
			cfg.DesktopSocketPath = ""
			if _, err := render.call(); enabled && err == nil {
				t.Fatalf("%s rendered sending without socket", render.name)
			}
			cfg.DesktopSocketPath = "/fixture/ipc.sock"
		}
	}
}
